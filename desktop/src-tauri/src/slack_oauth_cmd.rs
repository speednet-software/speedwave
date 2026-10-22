use crate::oauth_flow::{self, FlowRegistry, ProgressStatus};
use crate::oauth_loopback::{build_authorize_url, wait_for_callback, CallbackFailure};
use crate::slack_features;
use crate::types::check_project;
use serde::Deserialize;
use speedwave_runtime::consts::{self, SlackFeature};
use std::path::Path;
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
    enable_feature: Option<String>,
    app: tauri::AppHandle,
) -> Result<SlackOAuthResult, String> {
    check_project(&project)?;
    let feature = enable_feature
        .as_deref()
        .map(|id| consts::find_slack_feature(id).ok_or_else(|| "unknown Slack feature".to_string()))
        .transpose()?;
    let granted =
        slack_features::granted_scopes_in(consts::data_dir(), &project).unwrap_or_default();
    let scopes = slack_features::requested_scopes(&granted, feature);

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel.clone());

    let pkce = speedwave_runtime::pkce::generate_pkce();
    let state = speedwave_runtime::pkce::generate_state();

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

    let auth_redirect = build_authorize_url(
        consts::SLACK_OAUTH_AUTHORIZE_URL,
        consts::SLACK_OAUTH_CLIENT_ID,
        &redirect_uri,
        &scopes,
        &state,
        &pkce.challenge,
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

        let callback = wait_for_callback(&primary, secondary.as_ref(), &state, &cancel).await;
        let exchange = ExchangeRequest {
            token_url: consts::SLACK_OAUTH_TOKEN_URL,
            redirect_uri: &redirect_uri,
            verifier: &pkce.verifier,
        };
        let end = complete_flow(
            consts::data_dir(),
            &project,
            callback,
            &exchange,
            &scopes,
            || oauth_flow::superseded(&FLOW_STATE, my_generation, &request_id),
            || {
                oauth_flow::emit_progress(
                    &app,
                    &FLOW_STATE,
                    ProgressStatus::Exchanging,
                    "",
                    &request_id,
                )
            },
        )
        .await;
        match end {
            FlowEnd::Superseded => {}
            FlowEnd::Cancelled => oauth_flow::emit_terminal(
                &app,
                &FLOW_STATE,
                ProgressStatus::Cancelled,
                "OAuth flow cancelled",
                &request_id,
            ),
            FlowEnd::Failed(message) => oauth_flow::emit_terminal(
                &app,
                &FLOW_STATE,
                ProgressStatus::Error,
                &message,
                &request_id,
            ),
            FlowEnd::Done => {
                FLOW_STATE.clear_if_current(&request_id);
                oauth_flow::emit_progress(
                    &app,
                    &FLOW_STATE,
                    ProgressStatus::Success,
                    "",
                    &request_id,
                );
            }
        }
    });

    Ok(resp)
}

#[tauri::command]
pub fn cancel_slack_oauth() {
    FLOW_STATE.cancel();
}

const FEATURE_REFUSAL_CODES: &[&str] = &["invalid_scope", "unapproved_scope", "access_denied"];

/// How a sign-in attempt ended; only `Done` has written anything.
#[derive(Debug, PartialEq)]
enum FlowEnd {
    Cancelled,
    Superseded,
    Failed(String),
    Done,
}

struct ExchangeRequest<'a> {
    token_url: &'a str,
    redirect_uri: &'a str,
    verifier: &'a str,
}

/// Runs everything after the browser callback: exchange the code, then persist. Nothing is written
/// unless both succeed, so a refused, cancelled or timed-out sign-in keeps the previous grant.
async fn complete_flow(
    data_dir: &Path,
    project: &str,
    callback: Result<String, CallbackFailure>,
    exchange: &ExchangeRequest<'_>,
    requested_scopes: &[String],
    superseded: impl Fn() -> bool,
    on_exchanging: impl Fn(),
) -> FlowEnd {
    let features = slack_features::features_in(requested_scopes);
    let code = match callback {
        Ok(code) => code,
        Err(CallbackFailure::Cancelled) => return FlowEnd::Cancelled,
        Err(failure) => return FlowEnd::Failed(callback_failure_message(&failure, &features)),
    };
    if superseded() {
        return FlowEnd::Superseded;
    }
    on_exchanging();
    let token = match exchange_slack_code(
        exchange.token_url,
        &code,
        exchange.redirect_uri,
        exchange.verifier,
    )
    .await
    {
        Ok(token) => token,
        Err(raw) => return FlowEnd::Failed(exchange_failure_message(&raw, &features)),
    };
    if superseded() {
        return FlowEnd::Superseded;
    }
    match persist_slack_tokens_in(data_dir, project, &token, requested_scopes) {
        Ok(()) => FlowEnd::Done,
        Err(e) => FlowEnd::Failed(e),
    }
}

/// Wording for a callback failure. When the sign-in requested features, a refusal or timeout names
/// them; otherwise the consent-screen dead end is explained.
fn callback_failure_message(failure: &CallbackFailure, features: &[&SlackFeature]) -> String {
    let refused = match failure {
        CallbackFailure::TimedOut => true,
        CallbackFailure::Denied { provider_error, .. } => provider_error
            .as_deref()
            .is_some_and(|code| FEATURE_REFUSAL_CODES.contains(&code)),
        CallbackFailure::Cancelled | CallbackFailure::Error(_) => false,
    };
    if refused && !features.is_empty() {
        return slack_features::refusal_message(features);
    }
    if matches!(
        failure,
        CallbackFailure::Denied { provider_error: Some(code), .. } if code == "access_denied"
    ) {
        return ACCESS_DENIED_MESSAGE.to_string();
    }
    failure.message().to_string()
}

const ACCESS_DENIED_MESSAGE: &str = "Slack authorization was declined. If your workspace requires \
     app approval, ask a workspace admin to approve Speedwave and try again.";

/// Wording for a token-exchange failure, which reaches us as text only: the Slack error code is
/// looked up in it when the sign-in requested features.
fn exchange_failure_message(raw: &str, features: &[&SlackFeature]) -> String {
    let refused = FEATURE_REFUSAL_CODES.iter().any(|code| raw.contains(code));
    if refused && !features.is_empty() {
        return slack_features::refusal_message(features);
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

/// Persists the outcome in the order oauth state (refresh token), `features.json`, mounted access
/// token: a crash in between leaves recoverable state, and a failed write never pairs a new access
/// token with a feature file from the previous sign-in.
/// `data_dir`-parameterised so tests pass a tempdir (cf. `save_oauth_state_in`).
fn persist_slack_tokens_in(
    data_dir: &Path,
    project: &str,
    token: &SlackUserToken,
    requested_scopes: &[String],
) -> Result<(), String> {
    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert(
        "clientId".to_string(),
        consts::SLACK_OAUTH_CLIENT_ID.to_string(),
    );
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
            scopes: requested_scopes.to_vec(),
            granted_scopes: token.granted_scopes.clone(),
            refresh_token: &token.refresh_token,
            expires_in: token.expires_in,
        },
    )?;

    let svc_dir = speedwave_runtime::plugin::token_dir_in(data_dir, project, "slack");
    slack_features::write_features_file_in(&svc_dir, &token.granted_scopes)?;
    oauth_flow::save_credential_file(&svc_dir, "access_token", &token.access_token)
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test assertions use unwrap")]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot stub token endpoint: replies `status` + JSON `body`, returns the raw request.
    /// Second occurrence of this helper (first: plugin_oauth_cmd) — extract on the third.
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

    fn denied(provider_error: &str) -> CallbackFailure {
        CallbackFailure::Denied {
            provider_error: Some(provider_error.to_string()),
            message: format!("authorization denied: {provider_error}"),
        }
    }

    fn file_upload_features() -> Vec<&'static SlackFeature> {
        vec![consts::find_slack_feature("file_upload").unwrap()]
    }

    #[test]
    fn callback_failure_without_features_explains_access_denied_and_keeps_the_rest() {
        let msg = callback_failure_message(&denied("access_denied"), &[]);
        assert!(msg.contains("workspace admin"), "got: {msg}");
        assert_eq!(
            callback_failure_message(&CallbackFailure::TimedOut, &[]),
            "OAuth flow timed out"
        );
        assert_eq!(
            callback_failure_message(&denied("invalid_scope"), &[]),
            "authorization denied: invalid_scope"
        );
    }

    #[test]
    fn callback_failure_with_features_names_them_on_refusal_or_timeout() {
        let features = file_upload_features();
        let expected = slack_features::refusal_message(&features);
        for failure in [
            denied("invalid_scope"),
            denied("unapproved_scope"),
            denied("access_denied"),
            CallbackFailure::TimedOut,
        ] {
            assert_eq!(
                callback_failure_message(&failure, &features),
                expected,
                "failure: {failure:?}"
            );
        }
        for failure in [
            CallbackFailure::Denied {
                provider_error: None,
                message: "callback missing authorization code".to_string(),
            },
            CallbackFailure::Error("callback accept failed: x".to_string()),
        ] {
            assert_eq!(
                callback_failure_message(&failure, &features),
                failure.message()
            );
        }
    }

    #[test]
    fn exchange_failure_names_the_features_only_for_a_refusal_code() {
        let features = file_upload_features();
        assert_eq!(
            exchange_failure_message("token exchange failed: invalid_scope", &features),
            slack_features::refusal_message(&features)
        );
        assert_eq!(
            exchange_failure_message("token exchange failed: invalid_scope", &[]),
            "token exchange failed: invalid_scope"
        );
        assert_eq!(
            exchange_failure_message("token exchange failed: invalid_code", &features),
            "token exchange failed: invalid_code"
        );
    }

    fn requested() -> Vec<String> {
        slack_features::requested_scopes(&[], None)
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
        persist_slack_tokens_in(tmp.path(), "proj", &sample_token(), &requested()).unwrap();

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
        assert_eq!(
            state["scopes"].as_array().unwrap().len(),
            consts::SLACK_OAUTH_BASE_SCOPES.len()
        );

        let features = std::fs::read_to_string(
            speedwave_runtime::plugin::token_dir_in(tmp.path(), "proj", "slack")
                .join(consts::SLACK_FEATURES_FILE),
        )
        .unwrap();
        assert_eq!(features, r#"{"enabled":[]}"#);

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
        assert_eq!(users_info_url_from("noslash"), "noslash");
    }

    #[tokio::test]
    async fn fetch_display_name_returns_none_on_unreachable_endpoint() {
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
        persist_slack_tokens_in(tmp.path(), "proj", &token, &requested()).unwrap();
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

    #[test]
    fn persist_writes_the_features_file_before_the_access_token() {
        let tmp = tempfile::tempdir().unwrap();
        let mut token = sample_token();
        token.access_token = "x".repeat(crate::types::MAX_CREDENTIAL_BYTES + 1);
        let svc_dir = speedwave_runtime::plugin::token_dir_in(tmp.path(), "proj", "slack");

        let result = persist_slack_tokens_in(tmp.path(), "proj", &token, &requested());

        assert!(result.is_err());
        assert!(svc_dir.join(consts::SLACK_FEATURES_FILE).exists());
        assert!(!svc_dir.join("access_token").exists());
        assert!(
            speedwave_runtime::plugin::oauth_state_file_in(tmp.path(), "proj", "slack").exists()
        );
    }

    struct Stored {
        state: String,
        access_token: String,
        features: String,
    }

    fn stored(data_dir: &Path) -> Stored {
        let svc_dir = speedwave_runtime::plugin::token_dir_in(data_dir, "proj", "slack");
        let read = |path: std::path::PathBuf| std::fs::read_to_string(path).unwrap();
        Stored {
            state: read(speedwave_runtime::plugin::oauth_state_file_in(
                data_dir, "proj", "slack",
            )),
            access_token: read(svc_dir.join("access_token")),
            features: read(svc_dir.join(consts::SLACK_FEATURES_FILE)),
        }
    }

    fn seeded_data_dir() -> (tempfile::TempDir, Stored) {
        let tmp = tempfile::tempdir().unwrap();
        persist_slack_tokens_in(tmp.path(), "proj", &sample_token(), &requested()).unwrap();
        let before = stored(tmp.path());
        (tmp, before)
    }

    fn assert_unchanged(data_dir: &Path, before: &Stored) {
        let after = stored(data_dir);
        assert_eq!(after.state, before.state);
        assert_eq!(after.access_token, before.access_token);
        assert_eq!(after.features, before.features);
    }

    fn enable_file_upload_scopes() -> Vec<String> {
        slack_features::requested_scopes(&[], consts::find_slack_feature("file_upload"))
    }

    async fn run_flow(
        data_dir: &Path,
        callback: Result<String, CallbackFailure>,
        token_url: &str,
        scopes: &[String],
    ) -> FlowEnd {
        let exchange = ExchangeRequest {
            token_url,
            redirect_uri: "http://localhost:41739/callback",
            verifier: "ver",
        };
        complete_flow(
            data_dir,
            "proj",
            callback,
            &exchange,
            scopes,
            || false,
            || {},
        )
        .await
    }

    #[tokio::test]
    async fn failed_callbacks_persist_nothing() {
        let (tmp, before) = seeded_data_dir();
        let scopes = enable_file_upload_scopes();
        let refusal = slack_features::refusal_message(&file_upload_features());
        for failure in [denied("invalid_scope"), CallbackFailure::TimedOut] {
            let end = run_flow(tmp.path(), Err(failure), "http://127.0.0.1:1/x", &scopes).await;
            assert_eq!(end, FlowEnd::Failed(refusal.clone()));
            assert_unchanged(tmp.path(), &before);
        }
        let end = run_flow(
            tmp.path(),
            Err(CallbackFailure::Cancelled),
            "http://127.0.0.1:1/x",
            &scopes,
        )
        .await;
        assert_eq!(end, FlowEnd::Cancelled);
        assert_unchanged(tmp.path(), &before);
    }

    #[tokio::test]
    async fn a_refused_token_exchange_persists_nothing() {
        let (tmp, before) = seeded_data_dir();
        let (url, handle) =
            stub_token_endpoint(200, r#"{"ok": false, "error": "invalid_scope"}"#).await;

        let end = run_flow(
            tmp.path(),
            Ok("code".to_string()),
            &url,
            &enable_file_upload_scopes(),
        )
        .await;

        assert_eq!(
            end,
            FlowEnd::Failed(slack_features::refusal_message(&file_upload_features()))
        );
        assert_unchanged(tmp.path(), &before);
        let _ = handle.await;
    }

    #[tokio::test]
    async fn a_successful_exchange_replaces_the_stored_grant() {
        let (tmp, before) = seeded_data_dir();
        let (url, handle) = stub_token_endpoint(200, HAPPY_BODY).await;

        let end = run_flow(tmp.path(), Ok("code".to_string()), &url, &requested()).await;

        assert_eq!(end, FlowEnd::Done);
        let after = stored(tmp.path());
        assert_ne!(after.access_token, before.access_token);
        assert_ne!(after.state, before.state);
        let _ = handle.await;
    }

    #[test]
    fn persist_records_requested_scopes_and_enabled_features() {
        let tmp = tempfile::tempdir().unwrap();
        let mut token = sample_token();
        token.granted_scopes = vec!["chat:write".to_string(), "files:write".to_string()];
        let feature = consts::find_slack_feature("file_upload");
        let requested = slack_features::requested_scopes(&[], feature);
        persist_slack_tokens_in(tmp.path(), "proj", &token, &requested).unwrap();

        let state_raw = std::fs::read_to_string(speedwave_runtime::plugin::oauth_state_file_in(
            tmp.path(),
            "proj",
            "slack",
        ))
        .unwrap();
        let state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
        let persisted: Vec<String> = state["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(persisted, requested);
        assert!(persisted.contains(&"files:write".to_string()));

        let features = std::fs::read_to_string(
            speedwave_runtime::plugin::token_dir_in(tmp.path(), "proj", "slack")
                .join(consts::SLACK_FEATURES_FILE),
        )
        .unwrap();
        assert_eq!(features, r#"{"enabled":["file_upload"]}"#);
    }
}
