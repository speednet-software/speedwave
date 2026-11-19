use reqwest::blocking::Client;

use super::http;
use super::provider::{
    json_str, non_empty, positive_secs, split_scopes, ErrorCode, GrantType, RefreshRequest,
    RefreshResponse,
};
use crate::url_validation;

pub(super) fn refresh(req: &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> {
    validate(req)?;
    let url = validated_token_url(non_empty(req.provider_data, "tokenUrl")?)?;
    request(&http::build_client()?, &url, req)
}

fn validate(req: &RefreshRequest<'_>) -> Result<(), ErrorCode> {
    non_empty(req.provider_data, "tokenUrl")?;
    non_empty(req.provider_data, "clientId")?;
    if !matches!(
        req.provider_data.get("authStyle").map(String::as_str),
        None | Some("basic") | Some("body")
    ) {
        return Err(ErrorCode::InvalidConfig);
    }
    match req.grant_type {
        GrantType::RefreshToken if req.refresh_token.is_empty() => Err(ErrorCode::MissingField),
        GrantType::ClientCredentials => non_empty(req.provider_data, "clientSecret").map(|_| ()),
        GrantType::RefreshToken => Ok(()),
    }
}

fn validated_token_url(raw: &str) -> Result<String, ErrorCode> {
    let parsed = url_validation::validate_url(raw).map_err(|_| ErrorCode::InvalidConfig)?;
    if parsed.scheme() != "https" {
        return Err(ErrorCode::InvalidConfig);
    }
    Ok(parsed.to_string())
}

fn request(
    client: &Client,
    url: &str,
    req: &RefreshRequest<'_>,
) -> Result<RefreshResponse, ErrorCode> {
    let client_id = non_empty(req.provider_data, "clientId")?;
    let client_secret = req
        .provider_data
        .get("clientSecret")
        .map(String::as_str)
        .unwrap_or_default();
    let basic = req.provider_data.get("authStyle").map(String::as_str) != Some("body");
    let scope = req.scopes.join(" ");

    let mut form: Vec<(&str, &str)> = Vec::new();
    match req.grant_type {
        GrantType::RefreshToken => {
            form.push(("grant_type", "refresh_token"));
            form.push(("refresh_token", req.refresh_token));
        }
        GrantType::ClientCredentials => form.push(("grant_type", "client_credentials")),
    }
    if !scope.is_empty() {
        form.push(("scope", scope.as_str()));
    }
    let basic_auth = if basic {
        Some((client_id, client_secret))
    } else {
        form.push(("client_id", client_id));
        if !client_secret.is_empty() {
            form.push(("client_secret", client_secret));
        }
        None
    };

    let reply = http::post_form(client, url, basic_auth, &form)?;
    let body = reply.body;

    if !reply.success {
        return Err(if json_str(&body, "error") == Some("invalid_grant") {
            ErrorCode::InvalidGrant
        } else {
            ErrorCode::Http
        });
    }

    let access_token = json_str(&body, "access_token")
        .filter(|t| !t.is_empty())
        .ok_or(ErrorCode::Malformed)?;
    let expires_in = positive_secs(body.get("expires_in")).ok_or(ErrorCode::Malformed)?;
    let granted_scopes = match json_str(&body, "scope").map(str::trim) {
        Some(raw) if !raw.is_empty() => split_scopes(raw),
        _ => req.scopes.to_vec(),
    };
    Ok(RefreshResponse {
        access_token: access_token.to_string(),
        refresh_token: json_str(&body, "refresh_token")
            .filter(|t| !t.trim().is_empty())
            .map(str::to_string),
        expires_in,
        granted_scopes,
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn data(extra: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut map = BTreeMap::from([
            (
                "tokenUrl".to_string(),
                "https://idp.example.com/token".to_string(),
            ),
            ("clientId".to_string(), "cid".to_string()),
            ("clientSecret".to_string(), "sec".to_string()),
        ]);
        for (k, v) in extra {
            map.insert((*k).to_string(), (*v).to_string());
        }
        map
    }

    fn req<'a>(
        grant_type: GrantType,
        refresh_token: &'a str,
        scopes: &'a [String],
        provider_data: &'a BTreeMap<String, String>,
    ) -> RefreshRequest<'a> {
        RefreshRequest {
            grant_type,
            refresh_token,
            scopes,
            provider_data,
        }
    }

    fn token_mock(server: &mut mockito::Server) -> mockito::Mock {
        server
            .mock("POST", "/token")
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"access_token":"at","expires_in":3600,"refresh_token":"rt2","scope":"a b"}"#,
            )
    }

    #[test]
    fn basic_auth_is_the_default_and_the_secret_stays_out_of_the_body() {
        let mut server = mockito::Server::new();
        let m = token_mock(&mut server)
            .match_header("authorization", "Basic Y2lkOnNlYw==")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("grant_type".into(), "refresh_token".into()),
                mockito::Matcher::UrlEncoded("refresh_token".into(), "old".into()),
                mockito::Matcher::UrlEncoded("scope".into(), "a b".into()),
            ]))
            .create();
        let data = data(&[]);
        let scopes = vec!["a".to_string(), "b".to_string()];
        let out = request(
            &http::build_client().unwrap(),
            &format!("{}/token", server.url()),
            &req(GrantType::RefreshToken, "old", &scopes, &data),
        )
        .ok()
        .unwrap();
        m.assert();
        assert_eq!(out.access_token, "at");
        assert_eq!(out.refresh_token.as_deref(), Some("rt2"));
        assert_eq!(out.granted_scopes, vec!["a", "b"]);
    }

    #[test]
    fn body_style_sends_the_client_in_the_form() {
        let mut server = mockito::Server::new();
        let m = token_mock(&mut server)
            .match_header("authorization", mockito::Matcher::Missing)
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("client_id".into(), "cid".into()),
                mockito::Matcher::UrlEncoded("client_secret".into(), "sec".into()),
            ]))
            .create();
        let data = data(&[("authStyle", "body")]);
        let result = request(
            &http::build_client().unwrap(),
            &format!("{}/token", server.url()),
            &req(GrantType::RefreshToken, "old", &[], &data),
        );
        assert!(result.is_ok());
        m.assert();
    }

    #[test]
    fn client_credentials_sends_no_refresh_token() {
        let mut server = mockito::Server::new();
        let m = token_mock(&mut server)
            .match_body(mockito::Matcher::Exact(
                "grant_type=client_credentials".into(),
            ))
            .create();
        let data = data(&[]);
        let result = request(
            &http::build_client().unwrap(),
            &format!("{}/token", server.url()),
            &req(GrantType::ClientCredentials, "", &[], &data),
        );
        assert!(result.is_ok());
        m.assert();
    }

    #[test]
    fn missing_scope_in_the_response_keeps_the_requested_scopes() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/token")
            .with_header("content-type", "application/json")
            .with_body(r#"{"access_token":"at","expires_in":60}"#)
            .create();
        let data = data(&[]);
        let scopes = vec!["read".to_string()];
        let out = request(
            &http::build_client().unwrap(),
            &format!("{}/token", server.url()),
            &req(GrantType::RefreshToken, "old", &scopes, &data),
        )
        .ok()
        .unwrap();
        assert_eq!(out.granted_scopes, vec!["read"]);
        assert_eq!(out.refresh_token, None);
    }

    fn rejected(status: usize, body: &str) -> Option<ErrorCode> {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/token")
            .with_status(status)
            .with_header("content-type", "application/json")
            .with_body(body)
            .create();
        let data = data(&[]);
        request(
            &http::build_client().unwrap(),
            &format!("{}/token", server.url()),
            &req(GrantType::RefreshToken, "old", &[], &data),
        )
        .err()
    }

    #[test]
    fn invalid_grant_needs_a_reconnect_and_other_failures_are_retried() {
        assert_eq!(
            rejected(400, r#"{"error":"invalid_grant","error_description":"x"}"#),
            Some(ErrorCode::InvalidGrant)
        );
        assert_eq!(
            rejected(503, r#"{"error":"server_error"}"#),
            Some(ErrorCode::Http)
        );
        assert_eq!(
            rejected(200, r#"{"expires_in":10}"#),
            Some(ErrorCode::Malformed)
        );
        assert_eq!(
            rejected(200, r#"{"access_token":"at","expires_in":0}"#),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn token_url_must_be_public_https() {
        assert!(validated_token_url("https://idp.example.com/oauth/token").is_ok());
        for url in [
            "http://idp.example.com/token",
            "https://localhost/token",
            "https://127.0.0.1/token",
            "https://10.0.0.5/token",
            "https://192.168.1.1/token",
            "https://169.254.169.254/token",
            "https://user:pw@idp.example.com/token",
            "ftp://idp.example.com/token",
            "not a url",
        ] {
            assert_eq!(
                validated_token_url(url).err(),
                Some(ErrorCode::InvalidConfig),
                "{url}"
            );
        }
    }

    #[test]
    fn a_blocked_token_url_fails_before_any_request() {
        let data = data(&[("tokenUrl", "https://127.0.0.1/token")]);
        assert_eq!(
            refresh(&req(GrantType::RefreshToken, "old", &[], &data)).err(),
            Some(ErrorCode::InvalidConfig)
        );
    }

    #[test]
    fn incomplete_provider_data_is_rejected() {
        let ok = data(&[]);
        assert_eq!(
            validate(&req(GrantType::RefreshToken, "r", &[], &ok)),
            Ok(())
        );
        assert_eq!(
            validate(&req(GrantType::RefreshToken, "", &[], &ok)),
            Err(ErrorCode::MissingField)
        );
        let no_secret = BTreeMap::from([
            (
                "tokenUrl".to_string(),
                "https://idp.example.com/t".to_string(),
            ),
            ("clientId".to_string(), "cid".to_string()),
        ]);
        assert_eq!(
            validate(&req(GrantType::ClientCredentials, "", &[], &no_secret)),
            Err(ErrorCode::MissingField)
        );
        let bad_style = data(&[("authStyle", "header")]);
        assert_eq!(
            validate(&req(GrantType::RefreshToken, "r", &[], &bad_style)),
            Err(ErrorCode::InvalidConfig)
        );
        let no_client = BTreeMap::from([(
            "tokenUrl".to_string(),
            "https://idp.example.com/t".to_string(),
        )]);
        assert_eq!(
            validate(&req(GrantType::RefreshToken, "r", &[], &no_client)),
            Err(ErrorCode::MissingField)
        );
    }
}
