// Loopback-redirect plumbing shared by the authorization_code OAuth flows
// (plugins — ADR-069, Slack — ADR-071): callback server, CSRF-checked query
// parsing, and the PKCE authorize-URL builder.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// Why the callback wait ended without an authorization code. Cancellation is
/// distinct so the UI gets the quiet `cancelled` terminal, not a red `error`
/// (mirrors the device-code flow's direct `ProgressStatus::Cancelled`).
#[derive(Debug)]
pub(crate) enum CallbackFailure {
    Cancelled,
    Error(String),
}

/// Builds the authorize redirect URL with PKCE + state. `scope_param` is the
/// query key for scopes — `"scope"` (RFC 6749) for plugins, `"user_scope"`
/// for Slack (its `scope` would request forbidden bot scopes).
pub(crate) fn build_authorize_url(
    authorize_url: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
    scope_param: &str,
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
            .append_pair(scope_param, &scopes.join(" "));
    }
    Ok(url.to_string())
}

/// Accepts one loopback connection, parses the callback, verifies `state`,
/// returns the `code`. Honors cancellation and a fixed timeout. `secondary`
/// covers dual-stack listeners (a `localhost` redirect may resolve to ::1).
pub(crate) async fn wait_for_callback(
    listener: &tokio::net::TcpListener,
    secondary: Option<&tokio::net::TcpListener>,
    expected_state: &str,
    cancel: &CancellationToken,
) -> Result<String, CallbackFailure> {
    let accept = async {
        loop {
            let (mut stream, _) = accept_any(listener, secondary)
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
                // A single broken connection (port scan, etc.) must not abort the
                // flow — keep waiting, but record why for support.
                Err(e) => {
                    log::debug!("oauth callback read error (ignored): {e}");
                    continue;
                }
            }
        }
    };

    tokio::select! {
        _ = cancel.cancelled() => Err(CallbackFailure::Cancelled),
        _ = tokio::time::sleep(Duration::from_secs(300)) => {
            Err(CallbackFailure::Error("OAuth flow timed out".to_string()))
        }
        res = accept => res.map_err(CallbackFailure::Error),
    }
}

/// Accept from whichever listener gets a connection first.
async fn accept_any(
    primary: &tokio::net::TcpListener,
    secondary: Option<&tokio::net::TcpListener>,
) -> std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
    match secondary {
        None => primary.accept().await,
        Some(second) => tokio::select! {
            res = primary.accept() => res,
            res = second.accept() => res,
        },
    }
}

/// Max bytes read while looking for the request line — a long `code`/`state`
/// plus headers can exceed one TCP segment, so read until CRLF, not once.
pub(crate) const MAX_REQUEST_LINE_BYTES: usize = 16 * 1024;

/// Reads the HTTP request line; returns the `/callback?…` query string, or
/// `None` for a non-callback path. Reads until the first CRLF (bounded) so a
/// fragmented or oversized request line is not silently truncated.
pub(crate) async fn read_callback_request(
    stream: &mut tokio::net::TcpStream,
) -> Result<Option<String>, String> {
    let mut acc = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];
    let first_line = loop {
        if let Some(pos) = acc.windows(2).position(|w| w == b"\r\n") {
            break String::from_utf8_lossy(&acc[..pos]).into_owned();
        }
        if acc.len() >= MAX_REQUEST_LINE_BYTES {
            break String::from_utf8_lossy(&acc).into_owned();
        }
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break String::from_utf8_lossy(&acc).into_owned();
        }
        acc.extend_from_slice(&chunk[..n]);
    };
    // "GET /callback?code=…&state=… HTTP/1.1"
    let target = first_line.split_whitespace().nth(1).unwrap_or("");
    if let Some(q) = target.strip_prefix("/callback?") {
        Ok(Some(q.to_string()))
    } else {
        Ok(None)
    }
}

/// Verifies CSRF `state` and extracts `code` from the callback query.
pub(crate) fn parse_callback_query(query: &str, expected_state: &str) -> Result<String, String> {
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
    // Verify CSRF state first — for BOTH the success and error branches, so a
    // forged `?error=...` without a valid state can't terminate the flow
    // (RFC 6749 §10.12).
    if state.as_deref() != Some(expected_state) {
        return Err("state mismatch (possible CSRF)".to_string());
    }
    if let Some(e) = err {
        return Err(format!("authorization denied: {e}"));
    }
    match code {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err("callback missing authorization code".to_string()),
    }
}

/// Writes a minimal HTML response to the browser tab.
pub(crate) async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    body: &str,
) -> Result<(), String> {
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn build_authorize_url_includes_pkce_and_state() {
        let url = build_authorize_url(
            "https://idp.example.com/authorize",
            "cid",
            "http://127.0.0.1:5000/callback",
            &["read".to_string()],
            "st",
            "ch",
            "scope",
        )
        .unwrap();
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=ch"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st"));
        assert!(url.contains("scope=read"));
    }

    #[test]
    fn build_authorize_url_uses_custom_scope_param() {
        // Slack: scopes travel as `user_scope`; a plain `scope` key must NOT
        // appear (it would request bot scopes, forbidden on desktop redirects).
        let url = build_authorize_url(
            "https://slack.com/oauth/v2/authorize",
            "cid",
            "http://localhost:41739/callback",
            &["chat:write".to_string(), "users:read".to_string()],
            "st",
            "ch",
            "user_scope",
        )
        .unwrap();
        assert!(url.contains("user_scope=chat%3Awrite+users%3Aread"));
        assert!(!url.contains("&scope="));
    }

    #[test]
    fn build_authorize_url_omits_scope_when_empty() {
        let url = build_authorize_url(
            "https://idp.example.com/authorize",
            "cid",
            "http://127.0.0.1:5000/callback",
            &[],
            "st",
            "ch",
            "scope",
        )
        .unwrap();
        assert!(!url.contains("scope="));
    }

    #[test]
    fn build_authorize_url_rejects_invalid_base() {
        assert!(build_authorize_url("not a url", "cid", "r", &[], "s", "c", "scope").is_err());
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
    fn parse_callback_query_checks_state_before_error() {
        // A forged ?error= without a valid state is a CSRF mismatch, not a
        // "provider denied" — state is verified first on both branches.
        let err = parse_callback_query("error=access_denied", "xyz").unwrap_err();
        assert!(err.contains("state mismatch"), "got: {err}");
    }

    #[test]
    fn parse_callback_query_rejects_empty_code() {
        let err = parse_callback_query("code=&state=xyz", "xyz").unwrap_err();
        assert!(err.contains("missing authorization code"), "got: {err}");
    }

    // The request line may arrive split across TCP segments; read_callback_request
    // must accumulate until CRLF, not truncate on the first read.
    #[tokio::test]
    async fn read_callback_request_handles_fragmented_request_line() {
        use std::time::Duration;
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();

        let writer = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
            // Split the request line mid-query, with a pause between writes.
            client.write_all(b"GET /callback?code=ab").await.unwrap();
            client.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            client
                .write_all(b"c&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .unwrap();
            client.flush().await.unwrap();
        });

        let (mut server, _) = listener.accept().await.unwrap();
        let query = read_callback_request(&mut server).await.unwrap();
        assert_eq!(query.as_deref(), Some("code=abc&state=xyz"));
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn read_callback_request_returns_none_for_non_callback_path() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let writer = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
            client
                .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            client.flush().await.unwrap();
        });
        let (mut server, _) = listener.accept().await.unwrap();
        assert_eq!(read_callback_request(&mut server).await.unwrap(), None);
        writer.await.unwrap();
    }

    // An endless request line must not grow the accumulator unboundedly — the
    // reader stops at MAX_REQUEST_LINE_BYTES and parses what it has.
    #[tokio::test]
    async fn read_callback_request_caps_oversized_request_line() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let writer = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
            let _ = client.write_all(b"GET /not-callback").await;
            let _ = client
                .write_all(&vec![b'a'; MAX_REQUEST_LINE_BYTES * 2])
                .await;
            let _ = client.flush().await;
        });
        let (mut server, _) = listener.accept().await.unwrap();
        assert_eq!(read_callback_request(&mut server).await.unwrap(), None);
        drop(server);
        let _ = writer.await;
    }

    // User cancellation must surface as CallbackFailure::Cancelled (quiet
    // `cancelled` UI terminal), never as the red `error` status.
    #[tokio::test]
    async fn wait_for_callback_cancellation_is_distinct_from_error() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = wait_for_callback(&listener, None, "st", &cancel).await;
        assert!(
            matches!(result, Err(CallbackFailure::Cancelled)),
            "got: {result:?}"
        );
    }

    // Dual-stack: a connection on the SECONDARY listener must be served too
    // (a `localhost` redirect may resolve to ::1 while the primary is IPv4).
    #[tokio::test]
    async fn wait_for_callback_accepts_on_secondary_listener() {
        use tokio::io::AsyncWriteExt;
        let primary = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let secondary = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let secondary_addr = secondary.local_addr().unwrap();
        let cancel = CancellationToken::new();

        let writer = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(secondary_addr)
                .await
                .unwrap();
            client
                .write_all(b"GET /callback?code=abc&state=st HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            client.flush().await.unwrap();
            let mut out = Vec::new();
            let _ = client.read_to_end(&mut out).await;
        });

        let code = wait_for_callback(&primary, Some(&secondary), "st", &cancel)
            .await
            .unwrap();
        assert_eq!(code, "abc");
        writer.await.unwrap();
    }
}
