// GitHub OAuth App Device Flow. No refresh token — only access_token in the
// worker-mounted token dir. State machine in `oauth_flow`.

use crate::oauth_flow::{
    self, emit_error, save_credential_file, DeviceCodeInfo, DeviceCodeProvider, FlowRegistry,
    PollStep,
};
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
fn map_github_error(code: &str) -> Option<&'static str> {
    match code {
        "authorization_pending" | "slow_down" => None,
        // Canonical wording shared with the deadline path + SharePoint.
        "expired_token" => Some(oauth_flow::DEVICE_CODE_EXPIRED_MSG),
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

/// GitHub-specific device-code polling behaviour. Drives the shared
/// `run_device_code_poll` loop in `oauth_flow`.
struct GithubProvider {
    project: String,
    device_code: String,
}

impl DeviceCodeProvider for GithubProvider {
    fn token_request(&self, client: &reqwest::Client) -> reqwest::RequestBuilder {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", GITHUB_OAUTH_CLIENT_ID)
            .append_pair("device_code", &self.device_code)
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .finish();
        // GitHub: must send `Accept: application/json` or response is form-encoded.
        client
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
    }

    fn handle_token_response(
        &self,
        http_status: reqwest::StatusCode,
        body_bytes: &[u8],
    ) -> PollStep {
        // GitHub returns 200 for both success and polling errors.
        if let Ok(tokens) = serde_json::from_slice::<GhTokenResponse>(body_bytes) {
            let svc_dir = match speedwave_runtime::plugin::token_dir(&self.project, "github") {
                Ok(d) => d,
                Err(e) => return emit_error(format!("Failed to resolve token dir: {e}")),
            };
            if let Err(e) = save_credential_file(&svc_dir, "token", &tokens.access_token) {
                return emit_error(format!("Failed to save token: {e}"));
            }
            return PollStep::Emit {
                status: "success",
                message: "Authentication successful".to_string(),
            };
        }

        if let Ok(err) = serde_json::from_slice::<GhTokenErrorResponse>(body_bytes) {
            match map_github_error(err.error.as_str()) {
                None => {
                    return PollStep::KeepPolling {
                        slow_down: err.error == "slow_down",
                    }
                }
                Some(msg) => {
                    let full = err
                        .error_description
                        .map(|d| format!("{msg} ({d})"))
                        .unwrap_or_else(|| msg.to_string());
                    let status = if err.error == "expired_token" {
                        "expired"
                    } else {
                        "error"
                    };
                    return PollStep::Emit {
                        status,
                        message: full,
                    };
                }
            }
        }

        let preview = String::from_utf8_lossy(body_bytes);
        let truncated = if preview.len() > 200 {
            &preview[..200]
        } else {
            &preview
        };
        emit_error(format!(
            "Unexpected response from GitHub (HTTP {http_status}): {truncated}"
        ))
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

    let provider = GithubProvider {
        project: project.clone(),
        device_code: dc_resp.device_code.clone(),
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

    // -- GithubProvider::handle_token_response classification --

    fn provider() -> GithubProvider {
        GithubProvider {
            project: "p".to_string(),
            device_code: "dc".to_string(),
        }
    }

    fn ok_status() -> reqwest::StatusCode {
        reqwest::StatusCode::OK
    }

    #[test]
    fn provider_pending_keeps_polling_without_slow_down() {
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
    fn provider_expired_token_emits_expired_status() {
        let body = br#"{"error":"expired_token"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, .. } => assert_eq!(status, "expired"),
            PollStep::KeepPolling { .. } => panic!("expired_token must terminate"),
        }
    }

    #[test]
    fn provider_access_denied_emits_error_status() {
        let body = br#"{"error":"access_denied"}"#;
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, "error");
                assert!(message.contains("denied"));
            }
            PollStep::KeepPolling { .. } => panic!("access_denied must terminate"),
        }
    }

    #[test]
    fn provider_unparseable_body_emits_unexpected_error() {
        let body = b"<html>nonsense</html>";
        match provider().handle_token_response(ok_status(), body) {
            PollStep::Emit { status, message } => {
                assert_eq!(status, "error");
                assert!(message.contains("Unexpected response from GitHub"));
            }
            PollStep::KeepPolling { .. } => panic!("garbage body must terminate"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn provider_success_saves_token_and_emits_success() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("SPEEDWAVE_DATA_DIR").ok();
        std::env::set_var("SPEEDWAVE_DATA_DIR", tmp.path());

        let body = br#"{"access_token":"gho_secret","token_type":"bearer"}"#;
        let step = provider().handle_token_response(ok_status(), body);
        match step {
            PollStep::Emit { status, .. } => assert_eq!(status, "success"),
            PollStep::KeepPolling { .. } => panic!("success must terminate"),
        }
        let token_path = speedwave_runtime::plugin::token_dir("p", "github")
            .unwrap()
            .join("token");
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), "gho_secret");

        match prev {
            Some(v) => std::env::set_var("SPEEDWAVE_DATA_DIR", v),
            None => std::env::remove_var("SPEEDWAVE_DATA_DIR"),
        }
    }
}
