// GitHub OAuth App Device Flow. No refresh token — only access_token in the
// worker-mounted token dir. State machine in `oauth_flow`.

use crate::oauth_flow::{self, save_credential_file, DeviceCodeInfo, FlowRegistry};
use crate::types::check_project;
use serde::Deserialize;
use speedwave_runtime::consts::{GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_SCOPES};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const PROGRESS_EVENT: &str = "github_oauth_progress";

// ---------------------------------------------------------------------------
// Serde DTOs — GitHub OAuth App device flow responses
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GhDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct GhTokenResponse {
    access_token: String,
    #[serde(rename = "token_type")]
    _token_type: String,
    #[serde(default, rename = "scope")]
    _scope: String,
}

#[derive(Deserialize)]
struct GhTokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

static FLOW_STATE: FlowRegistry = FlowRegistry::new(PROGRESS_EVENT);

/// `None` = keep polling (`authorization_pending` / `slow_down`).
/// Classifies a GitHub token-poll body into a [`PollAction`], or `Ok(())` when
/// it carries an access token. Pure — the shared poll loop drives the effects.
fn classify_github_response(bytes: &[u8]) -> Result<(), oauth_flow::PollAction> {
    use oauth_flow::PollAction;
    if serde_json::from_slice::<GhTokenResponse>(bytes).is_ok() {
        return Ok(());
    }
    if let Ok(err) = serde_json::from_slice::<GhTokenErrorResponse>(bytes) {
        return match map_github_error(err.error.as_str()) {
            None if err.error == "slow_down" => Err(PollAction::SlowDown),
            None => Err(PollAction::KeepPolling),
            Some(msg) => {
                let full = err
                    .error_description
                    .map(|d| format!("{msg} ({d})"))
                    .unwrap_or_else(|| msg.to_string());
                if err.error == "expired_token" {
                    Err(PollAction::Expired(full))
                } else {
                    Err(PollAction::Failed(full))
                }
            }
        };
    }
    let preview = String::from_utf8_lossy(bytes);
    let truncated = preview.chars().take(200).collect::<String>();
    Err(PollAction::Failed(format!(
        "Unexpected response from GitHub: {truncated}"
    )))
}

fn map_github_error(code: &str) -> Option<&'static str> {
    match code {
        "authorization_pending" | "slow_down" => None,
        "expired_token" => Some("Device code expired — please reconnect."),
        "access_denied" => Some("Authorization was denied."),
        "incorrect_device_code" => Some("Internal error: device code rejected by GitHub."),
        "incorrect_client_credentials" => {
            Some("Speedwave GitHub OAuth App is misconfigured. Contact support.")
        }
        "device_flow_disabled" => {
            Some("Device flow is not enabled on the Speedwave GitHub OAuth App. Contact support.")
        }
        "unsupported_grant_type" => Some("Internal error: unsupported grant type."),
        _ => Some("GitHub returned an unexpected error."),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_github_oauth(
    project: String,
    app: tauri::AppHandle,
) -> Result<DeviceCodeInfo, String> {
    check_project(&project)?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_token = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel_token.clone())?;

    // GitHub: must send `Accept: application/json` or response is form-encoded.
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", GITHUB_OAUTH_CLIENT_ID)
        .append_pair("scope", GITHUB_OAUTH_SCOPES)
        .finish();

    let http_client = crate::http_util::build_hardened_client(None).inspect_err(|_| {
        FLOW_STATE.clear_if_current(&request_id);
    })?;
    let resp = http_client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            FLOW_STATE.clear_if_current(&request_id);
            format!("Failed to contact GitHub: {e}")
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
            "GitHub device code request failed (HTTP {status}): {preview}"
        ));
    }

    let dc_resp: GhDeviceCodeResponse = serde_json::from_slice(&body_bytes).map_err(|e| {
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
    let form_body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", GITHUB_OAUTH_CLIENT_ID)
        .append_pair("device_code", &dc_resp.device_code)
        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
        .finish();

    oauth_flow::run_device_poll(
        app,
        &FLOW_STATE,
        request_id,
        oauth_flow::DevicePollConfig {
            client: http_client,
            token_url: TOKEN_URL.to_string(),
            form_body,
            accept_json: true,
            interval_secs: dc_resp.interval,
            expires_in_secs: dc_resp.expires_in,
        },
        cancel_token,
        classify_github_response,
        move |bytes| {
            let tokens: GhTokenResponse =
                serde_json::from_slice(bytes).map_err(|e| format!("parse token: {e}"))?;
            let svc_dir = speedwave_runtime::plugin::token_dir(&poll_project, "github")
                .map_err(|e| e.to_string())?;
            save_credential_file(&svc_dir, "token", &tokens.access_token)
        },
    );

    Ok(info)
}

#[tauri::command]
pub fn cancel_github_oauth() {
    FLOW_STATE.cancel();
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn parse_device_code_response() {
        let json = r#"{
            "device_code": "abc",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }"#;
        let r: GhDeviceCodeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.device_code, "abc");
        assert_eq!(r.user_code, "WDJB-MJHT");
        assert_eq!(r.verification_uri, "https://github.com/login/device");
        assert_eq!(r.expires_in, 900);
        assert_eq!(r.interval, 5);
    }

    #[test]
    fn parse_token_success_response() {
        let json = r#"{
            "access_token": "gho_abc123",
            "token_type": "bearer",
            "scope": "repo,read:user"
        }"#;
        let r: GhTokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.access_token, "gho_abc123");
    }

    #[test]
    fn parse_token_success_without_scope_field() {
        let json = r#"{"access_token": "gho_x", "token_type": "bearer"}"#;
        let r: GhTokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.access_token, "gho_x");
    }

    #[test]
    fn parse_authorization_pending_error() {
        let json = r#"{"error": "authorization_pending", "error_description": "The authorization request is still pending."}"#;
        let r: GhTokenErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.error, "authorization_pending");
    }

    #[test]
    fn parse_slow_down_error() {
        let json = r#"{"error": "slow_down"}"#;
        let r: GhTokenErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.error, "slow_down");
        assert!(r.error_description.is_none());
    }

    #[test]
    fn map_authorization_pending_returns_none() {
        assert!(map_github_error("authorization_pending").is_none());
    }

    #[test]
    fn map_slow_down_returns_none() {
        assert!(map_github_error("slow_down").is_none());
    }

    #[test]
    fn map_expired_token_returns_message() {
        let m = map_github_error("expired_token").expect("expired_token should map");
        assert!(m.contains("expired"));
    }

    #[test]
    fn map_access_denied_returns_message() {
        let m = map_github_error("access_denied").expect("access_denied should map");
        assert!(m.contains("denied"));
    }

    #[test]
    fn map_incorrect_client_credentials_blames_speedwave_config() {
        let m = map_github_error("incorrect_client_credentials")
            .expect("incorrect_client_credentials should map");
        assert!(m.contains("Speedwave"));
        assert!(m.contains("misconfigured"));
    }

    #[test]
    fn map_device_flow_disabled_blames_speedwave_config() {
        let m = map_github_error("device_flow_disabled").expect("device_flow_disabled should map");
        assert!(m.contains("Speedwave"));
        assert!(m.contains("not enabled"));
    }

    #[test]
    fn map_incorrect_device_code_is_internal_error() {
        let m =
            map_github_error("incorrect_device_code").expect("incorrect_device_code should map");
        assert!(m.to_lowercase().contains("internal"));
    }

    #[test]
    fn map_unsupported_grant_type_is_internal_error() {
        let m =
            map_github_error("unsupported_grant_type").expect("unsupported_grant_type should map");
        assert!(m.to_lowercase().contains("internal"));
    }

    #[test]
    fn map_unknown_error_returns_generic_message() {
        let m = map_github_error("some_future_error").expect("unknown code should still map");
        assert!(m.to_lowercase().contains("unexpected"));
    }

    // -- classify_github_response: poll-loop mechanics --

    #[test]
    fn classify_accepts_success_body() {
        let body = br#"{"access_token":"a","token_type":"bearer","scope":"repo"}"#;
        assert!(classify_github_response(body).is_ok());
    }

    #[test]
    fn classify_pending_keeps_polling() {
        let body = br#"{"error":"authorization_pending"}"#;
        assert!(matches!(
            classify_github_response(body),
            Err(oauth_flow::PollAction::KeepPolling)
        ));
    }

    #[test]
    fn classify_slow_down_backs_off() {
        let body = br#"{"error":"slow_down"}"#;
        assert!(matches!(
            classify_github_response(body),
            Err(oauth_flow::PollAction::SlowDown)
        ));
    }

    #[test]
    fn classify_expired_token_is_expired() {
        let body = br#"{"error":"expired_token"}"#;
        assert!(matches!(
            classify_github_response(body),
            Err(oauth_flow::PollAction::Expired(_))
        ));
    }

    #[test]
    fn classify_access_denied_is_failed() {
        let body = br#"{"error":"access_denied"}"#;
        assert!(matches!(
            classify_github_response(body),
            Err(oauth_flow::PollAction::Failed(_))
        ));
    }

    #[test]
    fn classify_garbage_is_failed() {
        assert!(matches!(
            classify_github_response(b"not json"),
            Err(oauth_flow::PollAction::Failed(_))
        ));
    }
}
