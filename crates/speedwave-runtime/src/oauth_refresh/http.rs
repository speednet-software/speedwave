use std::io::Read;

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};

use super::provider::ErrorCode;
use crate::consts;

pub(super) struct Reply {
    pub(super) success: bool,
    pub(super) body: serde_json::Map<String, serde_json::Value>,
}

pub(super) fn build_client() -> Result<Client, ErrorCode> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(consts::OAUTH_REFRESH_HTTP_TIMEOUT)
        .user_agent(format!("Speedwave/{}", env!("SPEEDWAVE_VERSION")))
        .build()
        .map_err(|_| ErrorCode::Network)
}

pub(super) fn post_form(
    client: &Client,
    url: &str,
    basic_auth: Option<(&str, &str)>,
    form: &[(&str, &str)],
) -> Result<Reply, ErrorCode> {
    let mut request = client
        .post(url)
        .header(ACCEPT, "application/json")
        .form(form);
    if let Some((user, password)) = basic_auth {
        request = request.basic_auth(user, Some(password));
    }
    let response = request.send().map_err(|_| ErrorCode::Network)?;

    let status = response.status();
    if status.is_redirection() {
        return Err(ErrorCode::Http);
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    if !is_json(content_type) {
        return Err(ErrorCode::Malformed);
    }
    let max = consts::OAUTH_REFRESH_MAX_RESPONSE_BYTES;
    if response.content_length().is_some_and(|len| len > max) {
        return Err(ErrorCode::Malformed);
    }

    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ErrorCode::Network)?;
    if bytes.len() as u64 > max {
        return Err(ErrorCode::Malformed);
    }
    match serde_json::from_slice(&bytes) {
        Ok(serde_json::Value::Object(body)) => Ok(Reply {
            success: status.is_success(),
            body,
        }),
        _ => Err(ErrorCode::Malformed),
    }
}

fn is_json(content_type: Option<&str>) -> bool {
    let Some(value) = content_type else {
        return false;
    };
    let mime = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json"))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code: unwrap on fixtures is the sanctioned boundary"
)]
mod tests {
    use super::*;

    fn post(url: &str) -> Result<Reply, ErrorCode> {
        post_form(&build_client().unwrap(), url, None, &[("a", "b")])
    }

    #[test]
    fn json_content_types_are_recognised() {
        assert!(is_json(Some("application/json")));
        assert!(is_json(Some("Application/JSON; charset=utf-8")));
        assert!(is_json(Some("application/problem+json")));
        assert!(!is_json(Some("text/html")));
        assert!(!is_json(Some("text/json")));
        assert!(!is_json(None));
    }

    #[test]
    fn a_json_object_is_returned_with_its_status() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/t")
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"invalid_grant"}"#)
            .create();
        let reply = post(&format!("{}/t", server.url())).ok().unwrap();
        assert!(!reply.success);
        assert_eq!(reply.body["error"], "invalid_grant");
    }

    #[test]
    fn the_form_is_sent_url_encoded() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/t")
            .match_body(mockito::Matcher::UrlEncoded("a".into(), "b".into()))
            .with_header("content-type", "application/json")
            .with_body("{}")
            .create();
        assert!(post(&format!("{}/t", server.url())).is_ok());
        m.assert();
    }

    #[test]
    fn a_redirect_is_not_followed() {
        let mut server = mockito::Server::new();
        let target = server
            .mock("POST", "/elsewhere")
            .with_header("content-type", "application/json")
            .with_body("{}")
            .expect(0)
            .create();
        let _m = server
            .mock("POST", "/t")
            .with_status(302)
            .with_header("location", "/elsewhere")
            .create();
        assert_eq!(
            post(&format!("{}/t", server.url())).err(),
            Some(ErrorCode::Http)
        );
        target.assert();
    }

    #[test]
    fn a_non_json_response_is_malformed() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/t")
            .with_header("content-type", "text/html")
            .with_body("<html></html>")
            .create();
        assert_eq!(
            post(&format!("{}/t", server.url())).err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn a_json_value_that_is_not_an_object_is_malformed() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/t")
            .with_header("content-type", "application/json")
            .with_body("[1,2]")
            .create();
        assert_eq!(
            post(&format!("{}/t", server.url())).err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn a_response_over_the_size_limit_is_malformed() {
        let mut server = mockito::Server::new();
        let padding = "x".repeat(consts::OAUTH_REFRESH_MAX_RESPONSE_BYTES as usize);
        let _m = server
            .mock("POST", "/t")
            .with_header("content-type", "application/json")
            .with_body(format!(r#"{{"pad":"{padding}"}}"#))
            .create();
        assert_eq!(
            post(&format!("{}/t", server.url())).err(),
            Some(ErrorCode::Malformed)
        );
    }

    #[test]
    fn a_refused_connection_is_a_network_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            post(&format!("http://127.0.0.1:{port}/t")).err(),
            Some(ErrorCode::Network)
        );
    }
}
