use reqwest::blocking::Client;

use super::http;
use super::provider::{
    json_str, non_empty, positive_secs, split_scopes, ErrorCode, GrantType, RefreshRequest,
    RefreshResponse,
};
use crate::consts;

pub(super) fn refresh(req: &RefreshRequest<'_>) -> Result<RefreshResponse, ErrorCode> {
    let url = token_url(non_empty(req.provider_data, "tenantId")?)?;
    validate(req)?;
    request(&http::build_client()?, &url, req)
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

fn token_url(tenant: &str) -> Result<String, ErrorCode> {
    let valid = tenant
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && tenant.starts_with(|c: char| c.is_ascii_alphanumeric());
    if !valid {
        return Err(ErrorCode::InvalidConfig);
    }
    Ok(format!(
        "{}/{tenant}/oauth2/v2.0/token",
        consts::MICROSOFT_LOGIN_BASE_URL
    ))
}

fn request(
    client: &Client,
    url: &str,
    req: &RefreshRequest<'_>,
) -> Result<RefreshResponse, ErrorCode> {
    let client_id = non_empty(req.provider_data, "clientId")?;
    let scope = req.scopes.join(" ");
    let reply = http::post_form(
        client,
        url,
        None,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", req.refresh_token),
            ("scope", scope.as_str()),
        ],
    )?;
    let body = reply.body;

    if !reply.success {
        let rejected = json_str(&body, "error") == Some("invalid_grant");
        let description = json_str(&body, "error_description")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let scope_related = ["scope", "consent", "permission"]
            .iter()
            .any(|word| description.contains(word));
        return Err(match (rejected, scope_related) {
            (true, true) => ErrorCode::ScopeMismatch,
            (true, false) => ErrorCode::InvalidGrant,
            (false, _) => ErrorCode::Http,
        });
    }

    let access_token = json_str(&body, "access_token")
        .filter(|t| !t.is_empty())
        .ok_or(ErrorCode::Malformed)?;
    let expires_in = positive_secs(body.get("expires_in")).ok_or(ErrorCode::Malformed)?;
    let granted_scopes = json_str(&body, "scope")
        .map(split_scopes)
        .unwrap_or_default();

    let all_granted = req.scopes.iter().all(|wanted| {
        wanted.eq_ignore_ascii_case("offline_access")
            || granted_scopes
                .iter()
                .any(|granted| granted.eq_ignore_ascii_case(wanted))
    });
    if !all_granted {
        return Err(ErrorCode::ScopeMismatch);
    }

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

    fn data() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("clientId".to_string(), "cid".to_string()),
            ("tenantId".to_string(), "common".to_string()),
        ])
    }

    fn run(status: usize, body: &str) -> Result<RefreshResponse, ErrorCode> {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/common/oauth2/v2.0/token")
            .with_status(status)
            .with_header("content-type", "application/json")
            .with_body(body)
            .create();
        let data = data();
        let scopes = vec!["offline_access".to_string(), "Sites.Manage.All".to_string()];
        request(
            &http::build_client().unwrap(),
            &format!("{}/common/oauth2/v2.0/token", server.url()),
            &RefreshRequest {
                grant_type: GrantType::RefreshToken,
                refresh_token: "old",
                scopes: &scopes,
                provider_data: &data,
            },
        )
    }

    #[test]
    fn token_url_is_built_per_tenant() {
        assert_eq!(
            token_url("contoso.onmicrosoft.com").ok().as_deref(),
            Some("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token")
        );
    }

    #[test]
    fn a_tenant_that_could_change_the_path_is_rejected() {
        for tenant in ["", "..", ".", "a/b", "a?x=1", "a#b", "a b", "-x", "a\\b"] {
            assert_eq!(
                token_url(tenant).err(),
                Some(ErrorCode::InvalidConfig),
                "{tenant}"
            );
        }
    }

    #[test]
    fn success_returns_the_rotated_refresh_token() {
        let out = run(
            200,
            r#"{"access_token":"at","refresh_token":"rt2","expires_in":3599,"scope":"https://graph.microsoft.com/Sites.Manage.All"}"#,
        );
        let out = out.ok().unwrap();
        assert_eq!(out.access_token, "at");
        assert_eq!(out.refresh_token.as_deref(), Some("rt2"));
        assert_eq!(out.expires_in, 3599);
    }

    #[test]
    fn scope_match_is_case_insensitive_and_ignores_offline_access() {
        let out = run(
            200,
            r#"{"access_token":"at","expires_in":3600,"scope":"sites.manage.all"}"#,
        );
        assert_eq!(out.ok().unwrap().refresh_token, None);
    }

    #[test]
    fn a_missing_granted_scope_is_a_scope_mismatch() {
        let out = run(
            200,
            r#"{"access_token":"at","expires_in":3600,"scope":"User.Read"}"#,
        );
        assert_eq!(out.err(), Some(ErrorCode::ScopeMismatch));
    }

    #[test]
    fn invalid_grant_is_split_by_its_description() {
        assert_eq!(
            run(
                400,
                r#"{"error":"invalid_grant","error_description":"AADSTS65001: consent required"}"#
            )
            .err(),
            Some(ErrorCode::ScopeMismatch)
        );
        assert_eq!(
            run(
                400,
                r#"{"error":"invalid_grant","error_description":"AADSTS700082: expired"}"#
            )
            .err(),
            Some(ErrorCode::InvalidGrant)
        );
        assert_eq!(
            run(500, r#"{"error":"temporarily_unavailable"}"#).err(),
            Some(ErrorCode::Http)
        );
    }

    #[test]
    fn a_response_without_token_or_expiry_is_malformed() {
        assert_eq!(
            run(200, r#"{"expires_in":10}"#).err(),
            Some(ErrorCode::Malformed)
        );
        assert_eq!(
            run(200, r#"{"access_token":"at"}"#).err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn missing_identity_fields_are_reported_before_any_request() {
        let mut data = data();
        data.remove("tenantId");
        let req = RefreshRequest {
            grant_type: GrantType::RefreshToken,
            refresh_token: "r",
            scopes: &[],
            provider_data: &data,
        };
        assert_eq!(refresh(&req).err(), Some(ErrorCode::MissingField));
        let ok = self::data();
        let req = RefreshRequest {
            grant_type: GrantType::RefreshToken,
            refresh_token: "",
            scopes: &[],
            provider_data: &ok,
        };
        assert_eq!(refresh(&req).err(), Some(ErrorCode::MissingField));
    }
}
