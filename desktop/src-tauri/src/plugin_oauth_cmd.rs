// Plugin OAuth2 authorization_code flow (loopback redirect + PKCE, ADR-069). Minted refresh
// token + client credentials stay host-side under oauth/; only access token reaches the plugin.

use crate::oauth_flow::{self, FlowRegistry, ProgressStatus};
use crate::oauth_loopback::{build_authorize_url, wait_for_callback, CallbackFailure};
use crate::types::check_project;
use serde::Deserialize;
use speedwave_runtime::plugin::{OAuthAuthStyle, OAuthGrantType, PluginOAuthSpec};
use std::collections::HashMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROGRESS_EVENT: &str = "plugin_oauth_progress";

static FLOW_STATE: FlowRegistry = FlowRegistry::new(PROGRESS_EVENT);

/// RFC 6749 §5.1 makes `expires_in` OPTIONAL; default to 1h when omitted.
fn default_expires_in() -> u64 {
    3600
}

/// Token endpoint success payload (RFC 6749 §5.1).
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default = "default_expires_in")]
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

/// Returned immediately when the flow starts; the outcome arrives via
/// `plugin_oauth_progress` events keyed on `request_id`.
#[derive(serde::Serialize, Clone)]
pub(crate) struct PluginOAuthResult {
    pub request_id: String,
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
    // Credentials + per-instance base URL come from the saved seed, not args.
    let seed = read_oauth_seed(&project, &slug)?;
    let client_id = seed
        .get(&oauth.client_id_field)
        .cloned()
        .ok_or_else(|| format!("client id field '{}' not saved", oauth.client_id_field))?;
    let client_secret = oauth
        .client_secret_field
        .as_ref()
        .and_then(|k| seed.get(k).cloned());

    // Static manifest endpoints, or per-instance SSRF-validated ones from the seed. See ADR-069.
    let (resolved_authorize, token_url) = resolve_endpoints(oauth, &seed)?;
    let authorize_url =
        resolved_authorize.ok_or_else(|| "oauth.authorize_url missing".to_string())?;

    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let my_generation = FLOW_STATE.install(request_id.clone(), cancel.clone());

    let pkce = speedwave_runtime::pkce::generate_pkce();
    let state = speedwave_runtime::pkce::generate_state();

    // Loopback callback server on 127.0.0.1; manifest port, else ephemeral.
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
        &authorize_url,
        &client_id,
        &redirect_uri,
        &oauth.scopes,
        &state,
        &pkce.challenge,
        "scope",
    )
    .inspect_err(|_| FLOW_STATE.clear_if_current(&request_id))?;

    // Command returns request_id immediately; the flow runs in a spawned task.
    let oauth = oauth.clone();
    let seed = seed.clone();
    let resp = PluginOAuthResult {
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

        let code = match wait_for_callback(&listener, None, &state, &cancel).await {
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
                    &e,
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
        let token = match exchange_code(
            &oauth,
            &token_url,
            &code,
            &redirect_uri,
            &client_id,
            client_secret.as_deref(),
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
        // Re-check after the exchange (reqwest ignores the CancellationToken).
        if oauth_flow::superseded(&FLOW_STATE, my_generation, &request_id) {
            return;
        }

        if let Err(e) = persist_state(
            &project,
            &slug,
            &oauth,
            &token_url,
            &client_id,
            client_secret.as_deref(),
            &token,
        )
        .and_then(|()| write_access_token(&project, &slug, &token.access_token))
        .and_then(|()| project_base_url_to_mount(&project, &slug, &oauth, &seed))
        {
            oauth_flow::emit_terminal(&app, &FLOW_STATE, ProgressStatus::Error, &e, &request_id);
            return;
        }
        // Auto-enable the freshly-authorized plugin, best-effort. See ADR-069.
        if let Err(e) = crate::plugin_cmd::set_plugin_enabled_in_config(&project, &slug, true) {
            log::warn!("oauth[{slug}]: authorized but auto-enable failed: {e}");
        }
        FLOW_STATE.clear_if_current(&request_id);
        oauth_flow::emit_progress(&app, &FLOW_STATE, ProgressStatus::Success, "", &request_id);
    });

    Ok(resp)
}

#[tauri::command]
pub fn cancel_plugin_oauth() {
    FLOW_STATE.cancel();
}

/// Delete a plugin's host-side OAuth state, seed, and access token. The worker `forget` tool
/// derives service from a bearer the supervisor lacks, so the host clears the files directly.
#[tauri::command]
pub fn forget_plugin_oauth(project: String, slug: String) -> Result<(), String> {
    check_project(&project)?;
    // Cancel any in-flight flow first; FLOW_STATE is a singleton across all plugins.
    FLOW_STATE.cancel();
    crate::plugin_cmd::remove_oauth_offmount(&project, &slug)?;
    let access = access_token_path(&project, &slug)?;
    if let Err(e) = std::fs::remove_file(&access) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("failed to remove {}: {e}", access.display()));
        }
    }
    Ok(())
}

// ── Helpers ──

/// Reads the pre-auth seed (`oauth/<project>/<slug>.seed.json`).
fn read_oauth_seed(project: &str, slug: &str) -> Result<HashMap<String, String>, String> {
    let path = speedwave_runtime::plugin::oauth_seed_file(project, slug);
    let body = std::fs::read_to_string(&path)
        .map_err(|_| "OAuth client credentials are not configured yet".to_string())?;
    serde_json::from_str(&body).map_err(|e| format!("corrupt oauth seed: {e}"))
}

/// Returns `(authorize_url, token_url)`: static manifest URLs, or per-instance ones resolved
/// + SSRF-validated from the seed's base (ADR-069).
fn resolve_endpoints(
    oauth: &PluginOAuthSpec,
    seed: &HashMap<String, String>,
) -> Result<(Option<String>, String), String> {
    if oauth.base_url_field.is_some() {
        return speedwave_runtime::plugin::resolve_oauth_endpoints(oauth, seed)
            .map_err(|e| e.to_string());
    }
    let token_url = oauth
        .token_url
        .clone()
        .ok_or_else(|| "oauth.token_url missing".to_string())?;
    Ok((oauth.authorize_url.clone(), token_url))
}

/// Copies the per-instance base URL from the seed into the worker's `/tokens`
/// mount so the worker can read its API base. The seed remains the SSOT.
fn project_base_url_to_mount(
    project: &str,
    slug: &str,
    oauth: &PluginOAuthSpec,
    seed: &HashMap<String, String>,
) -> Result<(), String> {
    let Some(field) = oauth.base_url_field.as_deref() else {
        return Ok(());
    };
    let Some(value) = seed.get(field) else {
        return Ok(());
    };
    let dir = access_token_path(project, slug)?
        .parent()
        .ok_or_else(|| "base projection: no parent".to_string())?
        .to_path_buf();
    oauth_flow::save_credential_file(&dir, field, value)
}

async fn exchange_code(
    oauth: &PluginOAuthSpec,
    token_url: &str,
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
    let mut req = client.post(token_url).timeout(Duration::from_secs(30));
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
    token_url: &str,
    client_id: &str,
    client_secret: Option<&str>,
    token: &TokenResponse,
) -> Result<(), String> {
    let refresh_token = token.refresh_token.clone().ok_or_else(|| {
        "IdP returned no refresh_token — Speedwave's authorization_code flow requires one \
         (use a confidential client or an IdP that issues refresh tokens with PKCE)"
            .to_string()
    })?;
    let granted: Vec<String> = token
        .scope
        .as_deref()
        .map(|s| s.split_whitespace().map(String::from).collect())
        .unwrap_or_default();

    let provider_data = build_provider_data(oauth, token_url, client_id, client_secret);

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

/// providerData map the worker's generic refresh reads — contract is `GenericProviderData` in
/// `mcp-servers/oauth/src/providers/generic.ts`; `token_url` is the RESOLVED absolute URL.
fn build_provider_data(
    oauth: &PluginOAuthSpec,
    token_url: &str,
    client_id: &str,
    client_secret: Option<&str>,
) -> std::collections::BTreeMap<String, String> {
    let mut provider_data = std::collections::BTreeMap::new();
    provider_data.insert("tokenUrl".to_string(), token_url.to_string());
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
    provider_data
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
    Ok(speedwave_runtime::plugin::token_dir(project, slug)
        .map_err(|e| e.to_string())?
        .join("access_token"))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "unwrap/expect are fine in test assertions"
)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn spec() -> PluginOAuthSpec {
        PluginOAuthSpec {
            grant_type: OAuthGrantType::AuthorizationCode,
            token_url: Some("https://idp.example.com/token".to_string()),
            authorize_url: Some("https://idp.example.com/authorize".to_string()),
            device_authorization_url: None,
            base_url_field: None,
            authorize_suffix: None,
            token_suffix: None,
            scopes: vec!["read".to_string(), "write".to_string()],
            auth_style: OAuthAuthStyle::Basic,
            client_id_field: "client_id".to_string(),
            client_secret_field: Some("client_secret".to_string()),
            redirect_port: None,
        }
    }

    // Auto-enable must precede the success event; source-order check, not behavioral.
    #[test]
    fn start_plugin_oauth_auto_enables_on_success() {
        let src = include_str!("plugin_oauth_cmd.rs");
        let start = src
            .find("pub async fn start_plugin_oauth(")
            .expect("start_plugin_oauth must exist");
        // Slice up to the next top-level item so the window tracks fn growth.
        let end = src[start..]
            .find("\npub fn cancel_plugin_oauth(")
            .map(|p| start + p)
            .expect("the fn following start_plugin_oauth must exist");
        let body = &src[start..end];
        let enable_pos = body
            .find("set_plugin_enabled_in_config(&project, &slug, true)")
            .expect("success path must auto-enable the plugin");
        let success_pos = body
            .find("ProgressStatus::Success")
            .expect("success event must exist");
        assert!(
            enable_pos < success_pos,
            "auto-enable must run before the success event"
        );
    }

    #[test]
    fn resolve_endpoints_static_returns_manifest_urls() {
        let (authorize, token) = resolve_endpoints(&spec(), &HashMap::new()).unwrap();
        assert_eq!(token, "https://idp.example.com/token");
        assert_eq!(
            authorize.as_deref(),
            Some("https://idp.example.com/authorize")
        );
    }

    #[test]
    fn resolve_endpoints_derived_joins_seed_base() {
        let mut s = spec();
        s.token_url = None;
        s.authorize_url = None;
        s.base_url_field = Some("base".to_string());
        s.authorize_suffix = Some("/authorize".to_string());
        s.token_suffix = Some("/token".to_string());
        let mut seed = HashMap::new();
        seed.insert(
            "base".to_string(),
            "https://glpi.example.com/api.php".to_string(),
        );
        let (authorize, token) = resolve_endpoints(&s, &seed).unwrap();
        assert_eq!(token, "https://glpi.example.com/api.php/token");
        assert_eq!(
            authorize.as_deref(),
            Some("https://glpi.example.com/api.php/authorize")
        );
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

    /// One-shot stub token endpoint: replies `status` + JSON `body`, returns
    /// the raw request (headers + body) for assertions.
    async fn stub_token_endpoint(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
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

    #[tokio::test]
    async fn exchange_code_basic_style_uses_authorization_header() {
        let (url, handle) = stub_token_endpoint(
            200,
            r#"{"access_token":"at","refresh_token":"rt","expires_in":900}"#,
        )
        .await;
        let token = exchange_code(
            &spec(),
            &url,
            "code1",
            "http://127.0.0.1:1/callback",
            "cid",
            Some("sec"),
            "ver",
        )
        .await
        .unwrap();
        assert_eq!(token.access_token, "at");
        assert_eq!(token.refresh_token.as_deref(), Some("rt"));
        assert_eq!(token.expires_in, 900);

        let req = handle.await.unwrap();
        // base64("cid:sec") — credentials travel in the header, not the form.
        assert!(
            req.contains("Y2lkOnNlYw=="),
            "missing Basic credential: {req}"
        );
        let form = req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(form.contains("grant_type=authorization_code"));
        assert!(form.contains("code=code1"));
        assert!(form.contains("code_verifier=ver"));
        assert!(
            !form.contains("client_id="),
            "Basic style must not put client_id in the form"
        );
        assert!(!form.contains("client_secret="));
    }

    #[tokio::test]
    async fn exchange_code_body_style_puts_credentials_in_form() {
        let mut s = spec();
        s.auth_style = OAuthAuthStyle::Body;
        let (url, handle) =
            stub_token_endpoint(200, r#"{"access_token":"at","expires_in":60}"#).await;
        let token = exchange_code(
            &s,
            &url,
            "code1",
            "http://127.0.0.1:1/callback",
            "cid",
            Some("sec"),
            "ver",
        )
        .await
        .unwrap();
        // RFC 6749 §5.1: expires_in present, refresh_token absent is valid.
        assert_eq!(token.refresh_token, None);

        let req = handle.await.unwrap();
        assert!(!req.to_ascii_lowercase().contains("authorization:"));
        let form = req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(form.contains("client_id=cid"));
        assert!(form.contains("client_secret=sec"));
    }

    #[tokio::test]
    async fn exchange_code_surfaces_rfc6749_error_code() {
        let (url, handle) = stub_token_endpoint(400, r#"{"error":"invalid_grant"}"#).await;
        let err = exchange_code(
            &spec(),
            &url,
            "c",
            "http://127.0.0.1:1/callback",
            "cid",
            None,
            "v",
        )
        .await
        .map(|_| ())
        .unwrap_err();
        assert!(
            err.contains("token exchange failed: invalid_grant"),
            "got: {err}"
        );
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_code_maps_unparseable_error_body_to_http_error() {
        let (url, handle) = stub_token_endpoint(500, "not json at all").await;
        let err = exchange_code(
            &spec(),
            &url,
            "c",
            "http://127.0.0.1:1/callback",
            "cid",
            None,
            "v",
        )
        .await
        .map(|_| ())
        .unwrap_err();
        assert!(
            err.contains("token exchange failed: http_error"),
            "got: {err}"
        );
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exchange_code_rejects_malformed_success_body() {
        let (url, handle) = stub_token_endpoint(200, "{not valid json").await;
        let err = exchange_code(
            &spec(),
            &url,
            "c",
            "http://127.0.0.1:1/callback",
            "cid",
            None,
            "v",
        )
        .await
        .map(|_| ())
        .unwrap_err();
        assert!(err.contains("malformed token response"), "got: {err}");
        let _ = handle.await;
    }

    // An access token without refresh_token must fail loudly.
    #[test]
    fn persist_state_rejects_missing_refresh_token() {
        let token = TokenResponse {
            access_token: "at".to_string(),
            refresh_token: None,
            expires_in: 3600,
            scope: None,
        };
        let err = persist_state(
            "proj",
            "plug",
            &spec(),
            "https://idp.example.com/token",
            "cid",
            None,
            &token,
        )
        .unwrap_err();
        assert!(err.contains("no refresh_token"), "got: {err}");
    }

    // The worker's generic refresh reads these exact keys (GenericProviderData in generic.ts).
    #[test]
    fn build_provider_data_carries_worker_contract_keys() {
        let data =
            build_provider_data(&spec(), "https://idp.example.com/token", "cid", Some("sec"));
        let keys: Vec<&str> = data.keys().map(String::as_str).collect();
        assert_eq!(keys, ["authStyle", "clientId", "clientSecret", "tokenUrl"]);
        assert_eq!(data["authStyle"], "basic");
        assert_eq!(data["tokenUrl"], "https://idp.example.com/token");
        assert_eq!(data["clientId"], "cid");
        assert_eq!(data["clientSecret"], "sec");
    }

    #[test]
    fn build_provider_data_body_style_omits_absent_secret() {
        let mut s = spec();
        s.auth_style = OAuthAuthStyle::Body;
        let data = build_provider_data(&s, "https://idp.example.com/token", "cid", None);
        assert_eq!(data["authStyle"], "body");
        assert!(!data.contains_key("clientSecret"));
    }
}
