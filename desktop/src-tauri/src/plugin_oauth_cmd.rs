// Plugin OAuth2 authorization_code flow (loopback redirect + PKCE). The
// minted refresh token + client credentials stay host-side under oauth/; only
// a short-lived access token reaches the plugin container. See ADR-060 ext.

use crate::oauth_flow::{self, FlowRegistry};
use crate::types::check_project;
use serde::Deserialize;
use speedwave_runtime::plugin::{OAuthAuthStyle, OAuthGrantType, PluginOAuthSpec};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const PROGRESS_EVENT: &str = "plugin_oauth_progress";

static FLOW_STATE: FlowRegistry = FlowRegistry::new(PROGRESS_EVENT);

/// Token endpoint success payload (RFC 6749 §5.1).
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    scope: Option<String>,
}

/// Token endpoint error payload (RFC 6749 §5.2). `error` only — description is
/// not surfaced (may carry tenant/request detail).
#[derive(Deserialize)]
struct TokenErrorResponse {
    error: String,
}

/// Result returned to the UI on success.
#[derive(serde::Serialize, Clone)]
pub(crate) struct PluginOAuthResult {
    pub request_id: String,
    pub expires_in: u64,
}

#[tauri::command]
pub async fn start_plugin_oauth(
    project: String,
    slug: String,
    app: tauri::AppHandle,
) -> Result<PluginOAuthResult, String> {
    check_project(&project)?;
    let manifest = crate::plugin_cmd::require_verified_with_manifest(&slug)?;
    let oauth = manifest
        .oauth
        .as_ref()
        .ok_or_else(|| format!("plugin '{slug}' has no oauth block"))?;
    if oauth.grant_type != OAuthGrantType::AuthorizationCode {
        return Err(format!(
            "start_plugin_oauth: grant_type {} not supported here",
            oauth.grant_type.as_str()
        ));
    }
    let authorize_url = oauth
        .authorize_url
        .as_deref()
        .ok_or_else(|| "oauth.authorize_url missing".to_string())?;

    // CD-6: credentials come from the seed saved by save_plugin_credentials,
    // not from the command args.
    let seed = read_oauth_seed(&project, &slug)?;
    let client_id = seed
        .get(&oauth.client_id_field)
        .cloned()
        .ok_or_else(|| format!("client id field '{}' not saved", oauth.client_id_field))?;
    let client_secret = oauth
        .client_secret_field
        .as_ref()
        .and_then(|k| seed.get(k).cloned());

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel.clone())?;

    let pkce = speedwave_runtime::pkce::generate_pkce();
    let state = speedwave_runtime::pkce::generate_state();

    // Bind the loopback callback server on 127.0.0.1 (browser-side). Fixed port
    // if the manifest demands a registered redirect URI; else an ephemeral port.
    let bind_port = oauth.redirect_port.unwrap_or(0);
    // SSOT-allow: browser-side OAuth redirect URI is 127.0.0.1, not the container-reach host_bind_address (WSL adapter IP on Windows). See ADR-069.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", bind_port))
        .await
        .map_err(|e| {
            FLOW_STATE.clear_if_current(&request_id);
            format!("failed to bind loopback callback server: {e}")
        })?;
    let local_port = listener
        .local_addr()
        .map_err(|e| {
            FLOW_STATE.clear_if_current(&request_id);
            e.to_string()
        })?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{local_port}/callback");

    let auth_redirect = build_authorize_url(
        authorize_url,
        &client_id,
        &redirect_uri,
        &oauth.scopes,
        &state,
        &pkce.challenge,
    )
    .inspect_err(|_| FLOW_STATE.clear_if_current(&request_id))?;

    oauth_flow::emit_progress(
        &app,
        &FLOW_STATE,
        "awaiting_redirect",
        &redirect_uri,
        &request_id,
    );
    if let Err(e) = open::that(&auth_redirect) {
        log::warn!("could not open browser automatically: {e}");
    }

    // Await the callback (or cancel / timeout).
    let code = wait_for_callback(&listener, &state, &cancel, &request_id).await?;
    if FLOW_STATE.current_generation()? != my_generation {
        FLOW_STATE.clear_if_current(&request_id);
        return Err("OAuth flow was superseded".to_string());
    }

    oauth_flow::emit_progress(&app, &FLOW_STATE, "exchanging", "", &request_id);
    let token = exchange_code(
        oauth,
        &code,
        &redirect_uri,
        &client_id,
        client_secret.as_deref(),
        &pkce.verifier,
    )
    .await
    .inspect_err(|_| FLOW_STATE.clear_if_current(&request_id))?;

    persist_state(
        &project,
        &slug,
        oauth,
        &client_id,
        client_secret.as_deref(),
        &token,
    )?;
    write_access_token(&project, &slug, &token.access_token)?;

    FLOW_STATE.clear_if_current(&request_id);
    oauth_flow::emit_progress(&app, &FLOW_STATE, "success", "", &request_id);
    Ok(PluginOAuthResult {
        request_id,
        expires_in: token.expires_in,
    })
}

#[tauri::command]
pub fn cancel_plugin_oauth() {
    FLOW_STATE.cancel();
}

/// Delete a plugin's host-side OAuth state, seed, and access token. The worker
/// `forget` tool derives service from a bearer the supervisor lacks, so the
/// host clears the files directly.
#[tauri::command]
pub fn forget_plugin_oauth(project: String, slug: String) -> Result<(), String> {
    check_project(&project)?;
    let state = speedwave_runtime::plugin::oauth_state_file(&project, &slug);
    let seed = speedwave_runtime::plugin::oauth_seed_file(&project, &slug);
    let access = access_token_path(&project, &slug)?;
    for path in [state, seed, access] {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to remove {}: {e}", path.display()));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Reads the pre-auth seed (`oauth/<project>/<slug>.seed.json`).
fn read_oauth_seed(project: &str, slug: &str) -> Result<HashMap<String, String>, String> {
    let path = speedwave_runtime::plugin::oauth_seed_file(project, slug);
    let body = std::fs::read_to_string(&path)
        .map_err(|_| "OAuth client credentials are not configured yet".to_string())?;
    serde_json::from_str(&body).map_err(|e| format!("corrupt oauth seed: {e}"))
}

/// Builds the authorize redirect URL with PKCE + state.
fn build_authorize_url(
    authorize_url: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(authorize_url).map_err(|e| format!("bad authorize_url: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    if !scopes.is_empty() {
        url.query_pairs_mut()
            .append_pair("scope", &scopes.join(" "));
    }
    Ok(url.to_string())
}

/// Accepts one loopback connection, parses the callback, verifies `state`,
/// returns the `code`. Honors cancellation and a fixed timeout.
async fn wait_for_callback(
    listener: &tokio::net::TcpListener,
    expected_state: &str,
    cancel: &CancellationToken,
    request_id: &str,
) -> Result<String, String> {
    let accept = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("callback accept failed: {e}"))?;
            match read_callback_request(&mut stream).await {
                Ok(Some(query)) => {
                    let result = parse_callback_query(&query, expected_state);
                    let body = match &result {
                        Ok(_) => "Authorization complete. You can close this tab.",
                        Err(_) => "Authorization failed. You can close this tab.",
                    };
                    let _ = write_http_response(&mut stream, body).await;
                    return result;
                }
                // Ignore non-callback requests (favicon, etc.) and keep waiting.
                Ok(None) => {
                    let _ = write_http_response(&mut stream, "Waiting…").await;
                }
                Err(_) => continue,
            }
        }
    };

    tokio::select! {
        _ = cancel.cancelled() => {
            FLOW_STATE.clear_if_current(request_id);
            Err("OAuth flow was cancelled".to_string())
        }
        _ = tokio::time::sleep(Duration::from_secs(300)) => {
            FLOW_STATE.clear_if_current(request_id);
            Err("OAuth flow timed out".to_string())
        }
        res = accept => res,
    }
}

/// Reads the HTTP request line; returns the `/callback?…` query string, or
/// `None` for a non-callback path.
async fn read_callback_request(
    stream: &mut tokio::net::TcpStream,
) -> Result<Option<String>, String> {
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");
    // "GET /callback?code=…&state=… HTTP/1.1"
    let target = first_line.split_whitespace().nth(1).unwrap_or("");
    if let Some(q) = target.strip_prefix("/callback?") {
        Ok(Some(q.to_string()))
    } else {
        Ok(None)
    }
}

/// Verifies CSRF `state` and extracts `code` from the callback query.
fn parse_callback_query(query: &str, expected_state: &str) -> Result<String, String> {
    let mut code = None;
    let mut state = None;
    let mut err = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => err = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = err {
        return Err(format!("authorization denied: {e}"));
    }
    if state.as_deref() != Some(expected_state) {
        return Err("state mismatch (possible CSRF)".to_string());
    }
    code.ok_or_else(|| "callback missing authorization code".to_string())
}

/// Writes a minimal HTML response to the browser tab.
async fn write_http_response(stream: &mut tokio::net::TcpStream, body: &str) -> Result<(), String> {
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Exchanges the authorization code for tokens at the token endpoint.
async fn exchange_code(
    oauth: &PluginOAuthSpec,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: Option<&str>,
    verifier: &str,
) -> Result<TokenResponse, String> {
    let client = crate::http_util::build_hardened_client(None)?;
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    let mut req = client
        .post(&oauth.token_url)
        .timeout(Duration::from_secs(30));
    match oauth.auth_style {
        OAuthAuthStyle::Basic => {
            req = req.basic_auth(client_id, client_secret);
        }
        OAuthAuthStyle::Body => {
            form.push(("client_id", client_id));
            if let Some(secret) = client_secret {
                form.push(("client_secret", secret));
            }
        }
    }
    let resp = req
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token endpoint unreachable: {e}"))?;
    let status = resp.status();
    let bytes = crate::http_util::read_body_limited(resp, "token").await?;
    if !status.is_success() {
        let code = serde_json::from_slice::<TokenErrorResponse>(&bytes)
            .map(|e| e.error)
            .unwrap_or_else(|_| "http_error".to_string());
        return Err(format!("token exchange failed: {code}"));
    }
    serde_json::from_slice::<TokenResponse>(&bytes)
        .map_err(|e| format!("malformed token response: {e}"))
}

/// Writes the full OAuthState (provider=generic) off-mount via the runtime SSOT.
fn persist_state(
    project: &str,
    slug: &str,
    oauth: &PluginOAuthSpec,
    client_id: &str,
    client_secret: Option<&str>,
    token: &TokenResponse,
) -> Result<(), String> {
    let refresh_token = token
        .refresh_token
        .clone()
        .ok_or_else(|| "token response had no refresh_token".to_string())?;
    let granted: Vec<String> = token
        .scope
        .as_deref()
        .map(|s| s.split_whitespace().map(String::from).collect())
        .unwrap_or_default();

    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert("tokenUrl".to_string(), oauth.token_url.clone());
    provider_data.insert("clientId".to_string(), client_id.to_string());
    if let Some(secret) = client_secret {
        provider_data.insert("clientSecret".to_string(), secret.to_string());
    }
    provider_data.insert(
        "authStyle".to_string(),
        match oauth.auth_style {
            OAuthAuthStyle::Basic => "basic",
            OAuthAuthStyle::Body => "body",
        }
        .to_string(),
    );

    let path = speedwave_runtime::plugin::oauth_state_file(project, slug);
    speedwave_runtime::oauth_persist::write_oauth_state(
        &path,
        &speedwave_runtime::oauth_persist::OAuthStateParams {
            provider: "generic",
            grant_type: Some("refresh_token"),
            provider_data,
            scopes: oauth.scopes.clone(),
            granted_scopes: granted,
            refresh_token: &refresh_token,
            expires_in: token.expires_in,
        },
    )
}

/// Writes the short-lived access token to the plugin's tokens dir (mounted ro).
fn write_access_token(project: &str, slug: &str, access_token: &str) -> Result<(), String> {
    let path = access_token_path(project, slug)?;
    let dir = path
        .parent()
        .ok_or_else(|| "access: no parent".to_string())?;
    oauth_flow::save_credential_file(dir, "access_token", access_token)
}

/// `~/.speedwave/tokens/<project>/<slug>/access_token`.
fn access_token_path(project: &str, slug: &str) -> Result<std::path::PathBuf, String> {
    Ok(speedwave_runtime::consts::data_dir()
        .join("tokens")
        .join(project)
        .join(slug)
        .join("access_token"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn spec() -> PluginOAuthSpec {
        PluginOAuthSpec {
            grant_type: OAuthGrantType::AuthorizationCode,
            token_url: "https://idp.example.com/token".to_string(),
            authorize_url: Some("https://idp.example.com/authorize".to_string()),
            device_authorization_url: None,
            scopes: vec!["read".to_string(), "write".to_string()],
            auth_style: OAuthAuthStyle::Basic,
            client_id_field: "client_id".to_string(),
            client_secret_field: Some("client_secret".to_string()),
            redirect_port: None,
        }
    }

    #[test]
    fn build_authorize_url_includes_pkce_and_state() {
        let url = build_authorize_url(
            "https://idp.example.com/authorize",
            "cid",
            "http://127.0.0.1:5000/callback",
            &["read".to_string()],
            "st",
            "ch",
        )
        .unwrap();
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=ch"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st"));
        assert!(url.contains("scope=read"));
    }

    #[test]
    fn parse_callback_query_extracts_code_on_state_match() {
        let code = parse_callback_query("code=abc&state=xyz", "xyz").unwrap();
        assert_eq!(code, "abc");
    }

    #[test]
    fn parse_callback_query_rejects_state_mismatch() {
        let err = parse_callback_query("code=abc&state=evil", "xyz").unwrap_err();
        assert!(err.contains("state mismatch"));
    }

    #[test]
    fn parse_callback_query_surfaces_provider_error() {
        let err = parse_callback_query("error=access_denied&state=xyz", "xyz").unwrap_err();
        assert!(err.contains("access_denied"));
    }

    #[test]
    fn parse_callback_query_rejects_missing_code() {
        let err = parse_callback_query("state=xyz", "xyz").unwrap_err();
        assert!(err.contains("missing authorization code"));
    }

    #[test]
    fn access_token_path_is_under_tokens() {
        let p = access_token_path("proj", "my-plugin").unwrap();
        assert!(p
            .to_string_lossy()
            .contains("/tokens/proj/my-plugin/access_token"));
    }

    #[test]
    fn spec_round_trips_grant() {
        assert_eq!(spec().grant_type, OAuthGrantType::AuthorizationCode);
    }
}
