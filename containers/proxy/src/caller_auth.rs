use std::path::Path;

use axum::http::{header, HeaderMap};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::router::Config;

pub(crate) enum Expected {
    Unrestricted,
    Token(String),
    Unavailable,
}

pub(crate) fn expected(cfg: &Config) -> Expected {
    let Some(path) = cfg.caller_token_file.as_deref() else {
        return Expected::Unrestricted;
    };
    match read_token(path) {
        Some(token) => Expected::Token(token),
        None => {
            log::error!("the caller token file is missing or empty, rejecting the request");
            Expected::Unavailable
        }
    }
}

pub(crate) fn matches(presented: &str, expected: &str) -> bool {
    let presented = Sha256::digest(presented.as_bytes());
    let expected = Sha256::digest(expected.as_bytes());
    presented
        .iter()
        .zip(expected.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub(crate) fn basic_password(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let credentials = String::from_utf8(decoded).ok()?;
    let (_, password) = credentials.split_once(':')?;
    Some(password.to_string())
}

fn read_token(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let token = raw.trim();
    (!token.is_empty()).then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test fixture setup, failure aborts the test"
    )]
    use super::*;

    fn basic(credentials: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials);
        headers.insert(
            header::AUTHORIZATION,
            format!("Basic {encoded}").parse().unwrap(),
        );
        headers
    }

    #[test]
    fn matches_accepts_only_the_identical_secret() {
        assert!(matches("abc123", "abc123"));
        assert!(!matches("abc124", "abc123"));
        assert!(!matches("", "abc123"));
        assert!(!matches("abc1234", "abc123"));
    }

    #[test]
    fn basic_password_ignores_the_user_name() {
        assert_eq!(
            basic_password(&basic("anyone:s3cret")).as_deref(),
            Some("s3cret")
        );
        assert_eq!(basic_password(&basic(":s3cret")).as_deref(), Some("s3cret"));
        assert_eq!(basic_password(&basic("user:a:b")).as_deref(), Some("a:b"));
    }

    #[test]
    fn basic_password_rejects_other_shapes() {
        assert!(basic_password(&HeaderMap::new()).is_none());
        assert!(basic_password(&basic("no-colon")).is_none());
        let mut bearer = HeaderMap::new();
        bearer.insert(header::AUTHORIZATION, "Bearer abc".parse().unwrap());
        assert!(basic_password(&bearer).is_none());
        let mut garbage = HeaderMap::new();
        garbage.insert(header::AUTHORIZATION, "Basic !!!".parse().unwrap());
        assert!(basic_password(&garbage).is_none());
    }

    #[test]
    fn expected_reads_the_file_on_every_call() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("caller-token");
        let cfg = Config {
            caller_token_file: Some(file.clone()),
            ..Config::default()
        };
        assert!(matches!(expected(&cfg), Expected::Unavailable));
        std::fs::write(&file, "first\n").unwrap();
        assert!(matches!(expected(&cfg), Expected::Token(t) if t == "first"));
        std::fs::write(&file, "second\n").unwrap();
        assert!(matches!(expected(&cfg), Expected::Token(t) if t == "second"));
        std::fs::write(&file, "  \n").unwrap();
        assert!(matches!(expected(&cfg), Expected::Unavailable));
    }

    #[test]
    fn expected_without_a_configured_file_is_unrestricted() {
        assert!(matches!(
            expected(&Config::default()),
            Expected::Unrestricted
        ));
    }
}
