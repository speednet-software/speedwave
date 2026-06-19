// Slack OAuth2 authorization_code flow (loopback redirect + PKCE, ADR-071).

use crate::oauth_flow::{self, FlowRegistry, ProgressStatus};
use crate::oauth_loopback::{build_authorize_url, wait_for_callback, CallbackFailure};
use crate::types::check_project;
use serde::Deserialize;
use speedwave_runtime::consts;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROGRESS_EVENT: &str = "slack_oauth_progress";

static FLOW_STATE: FlowRegistry = FlowRegistry::new(PROGRESS_EVENT);

/// `authed_user` block of an `oauth.v2.access` user-scope exchange — the ONLY
/// place the user token lives (a top-level `access_token` would be a bot token).
#[derive(Deserialize)]
struct SlackAuthedUser {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
}

/// Workspace identity, persisted into providerData for the UI.
#[derive(Deserialize)]
struct SlackTeam {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Slack token-endpoint envelope. Slack signals failure as HTTP 200 +
/// `{ok:false, error}` — never trust the HTTP status alone.
#[derive(Deserialize)]
struct SlackTokenResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    authed_user: Option<SlackAuthedUser>,
    #[serde(default)]
    team: Option<SlackTeam>,
}

/// Validated outcome of the exchange — everything persist needs.
struct SlackUserToken {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    granted_scopes: Vec<String>,
    team_id: Option<String>,
    team_name: Option<String>,
    authed_user_id: Option<String>,
    authed_user_name: Option<String>,
}

/// Returned immediately when the flow starts; the outcome arrives via
/// `slack_oauth_progress` events keyed on `request_id`.
#[derive(serde::Serialize, Clone)]
pub(crate) struct SlackOAuthResult {
    pub request_id: String,
}

#[tauri::command]
pub async fn start_slack_oauth(
    project: String,
    app: tauri::AppHandle,
) -> Result<SlackOAuthResult, String> {
    check_project(&project)?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel.clone());

    let pkce = speedwave_runtime::pkce::generate_pkce();
    let state = speedwave_runtime::pkce::generate_state();

    // Fixed port registered on the Slack app; bind both 127.0.0.1 and ::1.
    let port = consts::SLACK_OAUTH_REDIRECT_PORT;
    // SSOT-allow: browser-side OAuth redirect listener, not a container-reach bind (see ADR-071; same rationale as plugin_oauth_cmd).
    let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
    let v6 = tokio::net::TcpListener::bind(("::1", port)).await;
    let (primary, secondary) = match (v4, v6) {
        (Ok(a), Ok(b)) => (a, Some(b)),
        (Ok(a), Err(_)) => (a, None),
        (Err(_), Ok(b)) => (b, None),
        (Err(e4), Err(_)) => {
            FLOW_STATE.clear_if_current(&request_id);
            return Err(format!(
                "port {port} is already in use ({e4}) — close the other application \
                 (or Speedwave instance) using it and try again"
            ));
        }
    };
    let redirect_uri = format!("http://localhost:{port}/callback");

    let scopes: Vec<String> = consts::SLACK_OAUTH_USER_SCOPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    let auth_redirect = build_authorize_url(
        consts::SLACK_OAUTH_AUTHORIZE_URL,
        consts::SLACK_OAUTH_CLIENT_ID,
        &redirect_uri,
        &scopes,
        &state,
        &pkce.challenge,
        // user_scope, never scope (bot scopes).
        "user_scope",
    )
    .inspect_err(|_| FLOW_STATE.clear_if_current(&request_id))?;

    let resp = SlackOAuthResult {
        request_id: request_id.clone(),
    };
    tokio::spawn(async move {
        oauth_flow::emit_progress(
            &app,
            &FLOW_STATE,
            ProgressStatus::AwaitingRedirect,
            &redirect_uri,
            &request_id,
        );
        if let Err(e) = open::that(&auth_redirect) {
            log::warn!("could not open browser automatically: {e}");
        }

        let code = match wait_for_callback(&primary, secondary.as_ref(), &state, &cancel).await {
            Ok(c) => c,
            Err(CallbackFailure::Cancelled) => {
                oauth_flow::emit_terminal(
                    &app,
                    &FLOW_STATE,
                    ProgressStatus::Cancelled,
                    "OAuth flow cancelled",
                    &request_id,
                );
                return;
            }
            Err(CallbackFailure::Error(e)) => {
                oauth_flow::emit_terminal(
                    &app,
                    &FLOW_STATE,
                    ProgressStatus::Error,
                    &friendly_callback_error(&e),
                    &request_id,
                );
                return;
            }
        };
        if oauth_flow::superseded(&FLOW_STATE, my_generation, &request_id) {
            return;
        }

        oauth_flow::emit_progress(
            &app,
            &FLOW_STATE,
            ProgressStatus::Exchanging,
            "",
            &request_id,
        );
        let token = match exchange_slack_code(
            consts::SLACK_OAUTH_TOKEN_URL,
            &code,
            &redirect_uri,
            &pkce.verifier,
        )
        .await
        {
            Ok(t) => t,
            Err(e) => {
                oauth_flow::emit_terminal(
                    &app,
                    &FLOW_STATE,
                    ProgressStatus::Error,
                    &e,
                    &request_id,
                );
                return;
            }
        };
        if oauth_flow::superseded(&FLOW_STATE, my_generation, &request_id) {
            return;
        }

        if let Err(e) = persist_slack_tokens(&project, &token) {
            oauth_flow::emit_terminal(&app, &FLOW_STATE, ProgressStatus::Error, &e, &request_id);
            return;
        }
        FLOW_STATE.clear_if_current(&request_id);
        oauth_flow::emit_progress(&app, &FLOW_STATE, ProgressStatus::Success, "", &request_id);
    });

    Ok(resp)
}

#[tauri::command]
pub fn cancel_slack_oauth() {
    FLOW_STATE.cancel();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Translate the raw callback failure into actionable wording for the
/// consent-screen dead ends (deny, pending admin approval).
fn friendly_callback_error(raw: &str) -> String {
    if raw.contains("access_denied") {
        return "Slack authorization was declined. If your workspace requires app approval, \
                ask a workspace admin to approve Speedwave and try again."
            .to_string();
    }
    raw.to_string()
}

/// `users.info` profile — only the display fields we persist for the UI.
#[derive(Deserialize)]
struct SlackUserInfoProfile {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    real_name: Option<String>,
}

#[derive(Deserialize)]
struct SlackUserInfoUser {
    #[serde(default)]
    real_name: Option<String>,
    #[serde(default)]
    profile: Option<SlackUserInfoProfile>,
}

#[derive(Deserialize)]
struct SlackUserInfoResponse {
    ok: bool,
    #[serde(default)]
    user: Option<SlackUserInfoUser>,
}

/// Best human-readable name from a users.info payload (display > real).
fn pick_display_name(user: SlackUserInfoUser) -> Option<String> {
    let from_profile = user.profile.and_then(|p| {
        p.display_name
            .filter(|s| !s.is_empty())
            .or(p.real_name.filter(|s| !s.is_empty()))
    });
    from_profile.or(user.real_name.filter(|s| !s.is_empty()))
}

/// Best-effort display-name lookup via `users.info`; returns None on any
/// failure. `users_info_url` is derived from the token URL.
async fn fetch_slack_display_name(
    users_info_url: &str,
    access_token: &str,
    user_id: &str,
) -> Option<String> {
    let client = crate::http_util::build_hardened_client(None).ok()?;
    let resp = client
        .get(users_info_url)
        .query(&[("user", user_id)])
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    let bytes = crate::http_util::read_body_limited(resp, "users.info")
        .await
        .ok()?;
    let body = serde_json::from_slice::<SlackUserInfoResponse>(&bytes).ok()?;
    if !body.ok {
        return None;
    }
    body.user.and_then(pick_display_name)
}

/// `users.info` endpoint derived from the token URL (`…/oauth.v2.access` →
/// `…/users.info`) — keeps a single SSOT for the Slack API base.
fn users_info_url_from(token_url: &str) -> String {
    match token_url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/users.info"),
        None => token_url.to_string(),
    }
}

/// Exchanges the authorization code for a user token at `oauth.v2.access`.
/// PKCE public client: `code_verifier` + `client_id`, never a client_secret.
async fn exchange_slack_code(
    token_url: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<SlackUserToken, String> {
    let client = crate::http_util::build_hardened_client(None)?;
    let form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
        ("client_id", consts::SLACK_OAUTH_CLIENT_ID),
    ];
    let resp = client
        .post(token_url)
        .timeout(Duration::from_secs(30))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token endpoint unreachable: {e}"))?;
    let status = resp.status();
    let bytes = crate::http_util::read_body_limited(resp, "token").await?;

    let body = serde_json::from_slice::<SlackTokenResponse>(&bytes)
        .map_err(|e| format!("malformed token response: {e}"))?;
    if !body.ok || !status.is_success() {
        let code = body.error.unwrap_or_else(|| format!("http_{status}"));
        return Err(format!("token exchange failed: {code}"));
    }

    let user = body.authed_user.ok_or_else(|| {
        "Slack returned no authed_user — check the app's user_scope configuration".to_string()
    })?;
    if let Some(tt) = user.token_type.as_deref() {
        if tt != "user" {
            return Err(format!("expected a user token, got token_type '{tt}'"));
        }
    }
    let access_token = user.access_token.filter(|t| !t.is_empty()).ok_or_else(|| {
        "Slack returned no user access token — check the app's user_scope configuration".to_string()
    })?;
    // Rotation is mandatory; refresh_token/expires_in are required.
    let refresh_token = user
        .refresh_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            "Slack returned no refresh_token — token rotation is not enabled on the Slack app"
                .to_string()
        })?;
    let expires_in = user.expires_in.filter(|&e| e > 0).ok_or_else(|| {
        "Slack returned no expires_in — token rotation is not enabled on the Slack app".to_string()
    })?;
    let granted_scopes: Vec<String> = user
        .scope
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let authed_user_id = user.id;
    let authed_user_name = match &authed_user_id {
        Some(uid) => {
            fetch_slack_display_name(&users_info_url_from(token_url), &access_token, uid).await
        }
        None => None,
    };

    Ok(SlackUserToken {
        access_token,
        refresh_token,
        expires_in,
        granted_scopes,
        team_id: body.team.as_ref().and_then(|t| t.id.clone()),
        team_name: body.team.as_ref().and_then(|t| t.name.clone()),
        authed_user_id,
        authed_user_name,
    })
}

/// Persists the outcome: oauth state (refresh token) FIRST, the mounted access
/// token second — a crash in between leaves recoverable state, never a mounted
/// token without refresh state.
fn persist_slack_tokens(project: &str, token: &SlackUserToken) -> Result<(), String> {
    persist_slack_tokens_in(speedwave_runtime::consts::data_dir(), project, token)
}

/// `data_dir`-parameterised so tests pass a tempdir (cf. `save_oauth_state_in`).
fn persist_slack_tokens_in(
    data_dir: &std::path::Path,
    project: &str,
    token: &SlackUserToken,
) -> Result<(), String> {
    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert(
        "clientId".to_string(),
        consts::SLACK_OAUTH_CLIENT_ID.to_string(),
    );
    // Workspace identity for the UI ("Connected to <team> as <user>").
    if let Some(team_id) = &token.team_id {
        provider_data.insert("teamId".to_string(), team_id.clone());
    }
    if let Some(team_name) = &token.team_name {
        provider_data.insert("teamName".to_string(), team_name.clone());
    }
    if let Some(user_id) = &token.authed_user_id {
        provider_data.insert("authedUserId".to_string(), user_id.clone());
    }
    if let Some(user_name) = &token.authed_user_name {
        provider_data.insert("authedUserName".to_string(), user_name.clone());
    }

    let state_path = speedwave_runtime::plugin::oauth_state_file_in(data_dir, project, "slack");
    speedwave_runtime::oauth_persist::write_oauth_state(
        &state_path,
        &speedwave_runtime::oauth_persist::OAuthStateParams {
            provider: crate::oauth_providers::SLACK_PROVIDER_ID,
            grant_type: Some("refresh_token"),
            provider_data,
            scopes: consts::SLACK_OAUTH_USER_SCOPES
                .iter()
                .map(|s| s.to_string())
                .collect(),
            granted_scopes: token.granted_scopes.clone(),
            refresh_token: &token.refresh_token,
            expires_in: token.expires_in,
        },
    )?;

    let svc_dir = speedwave_runtime::plugin::token_dir_in(data_dir, project, "slack");
    oauth_flow::save_credential_file(&svc_dir, "access_token", &token.access_token)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot stub token endpoint: replies `status` + JSON `body`, returns
    /// the raw request (headers + body) for assertions. Second occurrence of
    /// this helper (first: plugin_oauth_cmd tests) — extract on the third.
    async fn stub_token_endpoint(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!(
            "http://{}/api/oauth.v2.access",
            listener.local_addr().unwrap()
        );
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            let mut header_end = None;
            let mut content_len = 0usize;
            loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if header_end.is_none() {
                    if let Some(pos) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let headers = String::from_utf8_lossy(&req[..pos]).to_string();
                        content_len = headers
                            .lines()
                            .find_map(|l| {
                                let lower = l.to_ascii_lowercase();
                                lower
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                    }
                }
                if let Some(he) = header_end {
                    if req.len() >= he + content_len {
                        break;
                    }
                }
            }
            let resp = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).await.unwrap();
            let _ = stream.shutdown().await;
            String::from_utf8_lossy(&req).into_owned()
        });
        (url, handle)
    }

    const HAPPY_BODY: &str = r#"{
        "ok": true,
        "app_id": "A123",
        "access_token": "xoxb-bot-must-be-ignored",
        "token_type": "bot",
        "team": {"id": "T123", "name": "Speednet"},
        "authed_user": {
            "id": "U123",
            "access_token": "xoxe.xoxp-user",
            "refresh_token": "xoxe-1-refresh",
            "expires_in": 43200,
            "token_type": "user",
            "scope": "chat:write,users:read"
        }
    }"#;

    #[tokio::test]
    async fn exchange_extracts_user_token_from_authed_user_only() {
        let (url, handle) = stub_token_endpoint(200, HAPPY_BODY).await;
        let token = exchange_slack_code(&url, "code1", "http://localhost:41739/callback", "ver")
            .await
            .unwrap();
        assert_eq!(token.access_token, "xoxe.xoxp-user");
        assert_eq!(token.refresh_token, "xoxe-1-refresh");
        assert_eq!(token.expires_in, 43200);
        assert_eq!(token.granted_scopes, vec!["chat:write", "users:read"]);
        assert_eq!(token.team_id.as_deref(), Some("T123"));
        assert_eq!(token.team_name.as_deref(), Some("Speednet"));
        assert_eq!(token.authed_user_id.as_deref(), Some("U123"));

        let req = handle.await.unwrap();
        let form = req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(form.contains("grant_type=authorization_code"));
        assert!(form.contains("code=code1"));
        assert!(form.contains("code_verifier=ver"));
        assert!(form.contains(&format!("client_id={}", consts::SLACK_OAUTH_CLIENT_ID)));
        // PKCE public client: no secret, anywhere.
        assert!(!form.contains("client_secret"));
        assert!(!req.to_ascii_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn exchange_surfaces_ok_false_error_despite_http_200() {
        let (url, handle) =
            stub_token_endpoint(200, r#"{"ok": false, "error": "invalid_code"}"#).await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(
            err.contains("token exchange failed: invalid_code"),
            "got: {err}"
        );
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_rejects_response_without_authed_user() {
        let (url, handle) = stub_token_endpoint(
            200,
            r#"{"ok": true, "access_token": "xoxb-bot", "token_type": "bot"}"#,
        )
        .await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("no authed_user"), "got: {err}");
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_rejects_non_user_token_type() {
        let (url, handle) = stub_token_endpoint(
            200,
            r#"{"ok": true, "authed_user": {"access_token": "x", "token_type": "bot"}}"#,
        )
        .await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("token_type"), "got: {err}");
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_requires_rotation_fields() {
        // No refresh_token → must fail loudly (rotation off = misconfigured app).
        let (url, handle) = stub_token_endpoint(
            200,
            r#"{"ok": true, "authed_user": {"access_token": "xoxp-x", "token_type": "user"}}"#,
        )
        .await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("rotation"), "got: {err}");
        let _ = handle.await;

        // refresh_token present but no expires_in → same class of failure.
        let (url2, handle2) = stub_token_endpoint(
            200,
            r#"{"ok": true, "authed_user": {"access_token": "xoxp-x", "refresh_token": "r", "token_type": "user"}}"#,
        )
        .await;
        let err2 = exchange_slack_code(&url2, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err2.contains("rotation"), "got: {err2}");
        let _ = handle2.await;
    }

    #[tokio::test]
    async fn exchange_rejects_malformed_body() {
        let (url, handle) = stub_token_endpoint(200, "{not json").await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("malformed token response"), "got: {err}");
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_maps_http_error_without_slack_error_field() {
        let (url, handle) = stub_token_endpoint(500, r#"{"ok": false}"#).await;
        let err = exchange_slack_code(&url, "c", "http://localhost:41739/callback", "v")
            .await
            .map(|_| ())
            .unwrap_err();
        assert!(err.contains("http_500"), "got: {err}");
        let _ = handle.await;
    }

    #[test]
    fn friendly_callback_error_translates_access_denied() {
        let msg = friendly_callback_error("authorization denied: access_denied");
        assert!(msg.contains("workspace admin"), "got: {msg}");
        // Other errors pass through verbatim.
        assert_eq!(
            friendly_callback_error("OAuth flow timed out"),
            "OAuth flow timed out"
        );
    }

    fn sample_token() -> SlackUserToken {
        SlackUserToken {
            access_token: "xoxe.xoxp-at".to_string(),
            refresh_token: "xoxe-1-rt".to_string(),
            expires_in: 43200,
            granted_scopes: vec!["chat:write".to_string()],
            team_id: Some("T123".to_string()),
            team_name: Some("Speednet".to_string()),
            authed_user_id: Some("U123".to_string()),
            authed_user_name: Some("Jan Kowalski".to_string()),
        }
    }

    #[test]
    fn persist_writes_state_and_access_token() {
        let tmp = tempfile::tempdir().unwrap();
        persist_slack_tokens_in(tmp.path(), "proj", &sample_token()).unwrap();

        let state_raw = std::fs::read_to_string(speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "proj",
            "slack",
        ))
        .unwrap();
        let state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
        assert_eq!(state["provider"], "slack");
        assert_eq!(state["grantType"], "refresh_token");
        assert_eq!(state["refreshToken"], "xoxe-1-rt");
        assert_eq!(
            state["providerData"]["clientId"],
            consts::SLACK_OAUTH_CLIENT_ID
        );
        assert_eq!(state["providerData"]["teamName"], "Speednet");
        assert_eq!(state["providerData"]["authedUserId"], "U123");
        assert_eq!(state["providerData"]["authedUserName"], "Jan Kowalski");
        assert_eq!(state["grantedScopes"][0], "chat:write");

        let access = std::fs::read_to_string(
            speedwave_runtime::plugin::token_dir_in(tmp.path(), "proj", "slack")
                .join("access_token"),
        )
        .unwrap();
        assert_eq!(access, "xoxe.xoxp-at");
    }

    #[test]
    fn pick_display_name_prefers_profile_display_then_real() {
        let with_display = SlackUserInfoUser {
            real_name: Some("Top Real".into()),
            profile: Some(SlackUserInfoProfile {
                display_name: Some("Janek".into()),
                real_name: Some("Jan Kowalski".into()),
            }),
        };
        assert_eq!(pick_display_name(with_display).as_deref(), Some("Janek"));

        let display_empty = SlackUserInfoUser {
            real_name: Some("Top Real".into()),
            profile: Some(SlackUserInfoProfile {
                display_name: Some(String::new()),
                real_name: Some("Profile Real".into()),
            }),
        };
        assert_eq!(
            pick_display_name(display_empty).as_deref(),
            Some("Profile Real")
        );

        let no_profile = SlackUserInfoUser {
            real_name: Some("Top Real".into()),
            profile: None,
        };
        assert_eq!(pick_display_name(no_profile).as_deref(), Some("Top Real"));

        let nothing = SlackUserInfoUser {
            real_name: None,
            profile: Some(SlackUserInfoProfile {
                display_name: None,
                real_name: None,
            }),
        };
        assert_eq!(pick_display_name(nothing), None);
    }

    #[test]
    fn users_info_url_is_derived_from_token_url() {
        assert_eq!(
            users_info_url_from("https://slack.com/api/oauth.v2.access"),
            "https://slack.com/api/users.info"
        );
        // Degenerate input without a slash → returned unchanged (no panic).
        assert_eq!(users_info_url_from("noslash"), "noslash");
    }

    #[tokio::test]
    async fn fetch_display_name_returns_none_on_unreachable_endpoint() {
        // Nothing is listening — best-effort lookup must yield None, not error.
        let name =
            fetch_slack_display_name("http://127.0.0.1:1/api/users.info", "xoxe.xoxp-at", "U123")
                .await;
        assert_eq!(name, None);
    }

    #[test]
    fn persist_omits_absent_identity_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let mut token = sample_token();
        token.team_id = None;
        token.team_name = None;
        token.authed_user_id = None;
        persist_slack_tokens_in(tmp.path(), "proj", &token).unwrap();
        let state_raw = std::fs::read_to_string(speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "proj",
            "slack",
        ))
        .unwrap();
        let state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
        assert!(state["providerData"].get("teamName").is_none());
        assert!(state["providerData"].get("authedUserId").is_none());
    }

    // State-before-token ordering: the refresh token must already be on disk
    // when the mounted access token appears (ADR-071; source-order pin like
    // plugin_oauth_cmd's auto-enable test).
    #[test]
    fn persist_writes_oauth_state_before_access_token() {
        let src = include_str!("slack_oauth_cmd.rs");
        let start = src
            .find("fn persist_slack_tokens_in(")
            .expect("persist_slack_tokens_in must exist");
        let body = &src[start..];
        let state_pos = body
            .find("write_oauth_state(")
            .expect("state write must exist");
        let token_pos = body
            .find("save_credential_file(")
            .expect("access token write must exist");
        assert!(
            state_pos < token_pos,
            "oauth state must be persisted before the mounted access token"
        );
    }
}
