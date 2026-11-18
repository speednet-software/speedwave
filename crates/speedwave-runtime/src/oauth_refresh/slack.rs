use reqwest::blocking::Client;

use super::http;
use super::provider::{
    json_str, non_empty, positive_secs, split_scopes, ErrorCode, GrantType, RefreshRequest,
    RefreshResponse,
};
use crate::consts;

const REAUTH_ERROR_CODES: &[&str] = &[
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "token_revoked",
    "invalid_auth",
];

pub(super) fn refresh(req: &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> {
    validate(req)?;
    request(&http::build_client()?, consts::SLACK_OAUTH_TOKEN_URL, req)
}

fn validate(req: &RefreshRequest<'_>) -> Result<(), ErrorCode> {
    if req.grant_type != GrantType::RefreshToken {
        return Err(ErrorCode::InvalidConfig);
    }
    non_empty(req.provider_data, "clientId")?;
    if req.refresh_token.is_empty() {
        return Err(ErrorCode::MissingField);
    }
    Ok(())
}

fn request(
    client: &Client,
    url: &str,
    req: &RefreshRequest<'_>,
) -> Result<RefreshResponse, ErrorCode> {
    let client_id = non_empty(req.provider_data, "clientId")?;
    let reply = http::post_form(
        client,
        url,
        None,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", req.refresh_token),
            ("client_id", client_id),
        ],
    )?;
    let body = reply.body;

    if body.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let code = json_str(&body, "error").unwrap_or_default();
        return Err(if REAUTH_ERROR_CODES.contains(&code) {
            ErrorCode::InvalidGrant
        } else {
            ErrorCode::Http
        });
    }

    let fields = user_token_fields(&body)?;
    let expires_in = positive_secs(fields.expires_in).ok_or(ErrorCode::Malformed)?;
    let granted_scopes = match fields.scope.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => parse_scopes(raw),
        None => req.scopes.to_vec(),
    };
    Ok(RefreshResponse {
        access_token: fields.access_token.to_string(),
        refresh_token: fields.refresh_token.map(str::to_string),
        expires_in,
        granted_scopes,
    })
}

struct TokenFields<'a> {
    access_token: &'a str,
    refresh_token: Option<&'a str>,
    expires_in: Option<&'a serde_json::Value>,
    scope: Option<&'a str>,
}

fn user_token_fields(
    body: &serde_json::Map<String, serde_json::Value>,
) -> Result<TokenFields<'_>, ErrorCode> {
    if let Some(user) = body
        .get("authed_user")
        .and_then(serde_json::Value::as_object)
    {
        if json_str(user, "token_type").is_some_and(|t| t != "user") {
            return Err(ErrorCode::Malformed);
        }
        if let Some(access_token) = json_str(user, "access_token").filter(|t| !t.is_empty()) {
            return Ok(TokenFields {
                access_token,
                refresh_token: json_str(user, "refresh_token"),
                expires_in: user.get("expires_in"),
                scope: json_str(user, "scope"),
            });
        }
    }
    let access_token = json_str(body, "access_token")
        .filter(|t| !t.is_empty())
        .ok_or(ErrorCode::Malformed)?;
    if json_str(body, "token_type") != Some("user") {
        return Err(ErrorCode::Malformed);
    }
    Ok(TokenFields {
        access_token,
        refresh_token: json_str(body, "refresh_token"),
        expires_in: body.get("expires_in"),
        scope: json_str(body, "scope"),
    })
}

fn parse_scopes(raw: &str) -> Vec<String> {
    if raw.contains(',') {
        raw.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        split_scopes(raw)
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn data(client_id: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("clientId".to_string(), client_id.to_string())])
    }

    fn run(
        server: &mut mockito::Server,
        status: usize,
        content_type: &str,
        body: &str,
    ) -> Result<RefreshResponse, ErrorCode> {
        let _m = server
            .mock("POST", "/api/oauth.v2.access")
            .with_status(status)
            .with_header("content-type", content_type)
            .with_body(body)
            .create();
        let data = data("cid");
        let scopes = vec!["chat:write".to_string()];
        request(
            &http::build_client().unwrap(),
            &format!("{}/api/oauth.v2.access", server.url()),
            &RefreshRequest {
                grant_type: GrantType::RefreshToken,
                refresh_token: "xoxe-1-old",
                scopes: &scopes,
                provider_data: &data,
            },
        )
    }

    fn json(server: &mut mockito::Server, body: &str) -> Result<RefreshResponse, ErrorCode> {
        run(server, 200, "application/json", body)
    }

    #[test]
    fn posts_the_refresh_grant_with_the_client_id_only() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/api/oauth.v2.access")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("grant_type".into(), "refresh_token".into()),
                mockito::Matcher::UrlEncoded("refresh_token".into(), "xoxe-1-old".into()),
                mockito::Matcher::UrlEncoded("client_id".into(), "cid".into()),
            ]))
            .with_header("content-type", "application/json")
            .with_body(r#"{"ok":true,"access_token":"a","token_type":"user","expires_in":43200}"#)
            .create();
        let data = data("cid");
        let result = request(
            &http::build_client().unwrap(),
            &format!("{}/api/oauth.v2.access", server.url()),
            &RefreshRequest {
                grant_type: GrantType::RefreshToken,
                refresh_token: "xoxe-1-old",
                scopes: &[],
                provider_data: &data,
            },
        );
        assert!(result.is_ok());
        m.assert();
    }

    #[test]
    fn flat_response_yields_rotated_tokens_and_scopes() {
        let mut server = mockito::Server::new();
        let out = json(
            &mut server,
            r#"{"ok":true,"access_token":"new-access","token_type":"user","refresh_token":"xoxe-1-new","expires_in":43200,"scope":"chat:write,search:read"}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(out.access_token, "new-access");
        assert_eq!(out.refresh_token.as_deref(), Some("xoxe-1-new"));
        assert_eq!(out.expires_in, 43_200);
        assert_eq!(out.granted_scopes, vec!["chat:write", "search:read"]);
    }

    #[test]
    fn nested_authed_user_response_is_accepted() {
        let mut server = mockito::Server::new();
        let out = json(
            &mut server,
            r#"{"ok":true,"authed_user":{"access_token":"u","token_type":"user","refresh_token":"r2","expires_in":100,"scope":"a b"}}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(out.access_token, "u");
        assert_eq!(out.granted_scopes, vec!["a", "b"]);
    }

    #[test]
    fn missing_scope_falls_back_to_the_requested_scopes() {
        let mut server = mockito::Server::new();
        let out = json(
            &mut server,
            r#"{"ok":true,"access_token":"a","token_type":"user","expires_in":10}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(out.granted_scopes, vec!["chat:write"]);
        assert_eq!(out.refresh_token, None);
    }

    #[test]
    fn a_bot_token_is_never_accepted() {
        for body in [
            r#"{"ok":true,"access_token":"xoxb","token_type":"bot","expires_in":10}"#,
            r#"{"ok":true,"authed_user":{"access_token":"u","token_type":"bot","expires_in":10}}"#,
        ] {
            let mut server = mockito::Server::new();
            assert_eq!(json(&mut server, body).err(), Some(ErrorCode::Malformed));
        }
    }

    #[test]
    fn missing_expiry_means_rotation_is_off() {
        let mut server = mockito::Server::new();
        assert_eq!(
            json(
                &mut server,
                r#"{"ok":true,"access_token":"a","token_type":"user"}"#
            )
            .err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn dead_grant_codes_need_a_reconnect() {
        for code in [
            "invalid_refresh_token",
            "token_revoked",
            "token_expired",
            "invalid_grant",
            "invalid_auth",
        ] {
            let mut server = mockito::Server::new();
            let err = json(&mut server, &format!(r#"{{"ok":false,"error":"{code}"}}"#)).err();
            assert_eq!(err, Some(ErrorCode::InvalidGrant), "{code}");
        }
    }

    #[test]
    fn other_slack_errors_are_retried() {
        let mut server = mockito::Server::new();
        assert_eq!(
            json(&mut server, r#"{"ok":false,"error":"ratelimited"}"#).err(),
            Some(ErrorCode::Http)
        );
        let mut server = mockito::Server::new();
        assert_eq!(
            run(&mut server, 500, "application/json", "{}").err(),
            Some(ErrorCode::Http)
        );
    }

    #[test]
    fn a_non_json_response_is_malformed() {
        let mut server = mockito::Server::new();
        assert_eq!(
            run(&mut server, 502, "text/html", "<html>bad gateway</html>").err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn a_request_without_client_id_or_refresh_token_never_leaves_the_machine() {
        let empty = BTreeMap::new();
        let ok = data("cid");
        let req = |refresh_token, provider_data, grant_type| {
            validate(&RefreshRequest {
                grant_type,
                refresh_token,
                scopes: &[],
                provider_data,
            })
        };
        assert_eq!(
            req("r", &empty, GrantType::RefreshToken),
            Err(ErrorCode::MissingField)
        );
        assert_eq!(
            req("", &ok, GrantType::RefreshToken),
            Err(ErrorCode::MissingField)
        );
        assert_eq!(
            req("r", &ok, GrantType::ClientCredentials),
            Err(ErrorCode::InvalidConfig)
        );
        assert_eq!(req("r", &ok, GrantType::RefreshToken), Ok(()));
    }
}
