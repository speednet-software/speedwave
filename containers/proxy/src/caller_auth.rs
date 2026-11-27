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
