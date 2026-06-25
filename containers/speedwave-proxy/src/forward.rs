use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, http::StatusCode};

use crate::router::{resolve, Auth, Config, Scheme};
use crate::usage::{append_usage, sniff, UsageAcc};

/// Build the outbound `HeaderMap` for a forwarded request.
///
/// Passthrough: copy auth and Anthropic headers verbatim; inject nothing.
/// Swap: drop inbound auth, inject provider key from environment.
pub fn outbound_headers(auth: &Auth, inbound: &HeaderMap) -> HeaderMap {
    outbound_headers_with(auth, inbound, |name| std::env::var(name).ok())
}

/// Testable variant — `lookup` provides the provider key for swap legs.
pub fn outbound_headers_with(
    auth: &Auth,
    inbound: &HeaderMap,
    lookup: impl Fn(&str) -> Option<String>,
) -> HeaderMap {
    let mut out = HeaderMap::new();

    match auth {
        Auth::Passthrough => {
            // Copy auth and Anthropic headers verbatim — inject nothing.
            for name in &[
                "authorization",
                "x-api-key",
                "anthropic-beta",
                "anthropic-version",
                "content-type",
            ] {
                if let Some(v) = inbound.get(*name) {
                    out.insert(axum::http::header::HeaderName::from_static(name), v.clone());
                }
            }
        }
        Auth::Swap { env, scheme } => {
            // Drop inbound auth (client sends a dummy bearer on non-Anthropic legs).
            // Keep non-auth Anthropic headers.
            for name in &["anthropic-version", "content-type"] {
                if let Some(v) = inbound.get(*name) {
                    out.insert(axum::http::header::HeaderName::from_static(name), v.clone());
                }
            }
            // Inject real provider key according to scheme.
            if let Some(key) = lookup(env) {
                match scheme {
                    Scheme::Bearer => {
                        let value = format!("Bearer {key}");
                        if let Ok(v) = value.parse() {
                            out.insert(axum::http::header::AUTHORIZATION, v);
                        }
                    }
                    Scheme::None => {
                        // Local servers accept any/none — no auth header.
                    }
                }
            }
        }
    }

    out
}

/// Stub — full streaming forward implemented in Task 6.
pub async fn messages(State(cfg): State<Arc<Config>>) -> StatusCode {
    // Route resolution, auth-header injection, and usage sniffing are wired in Task 6.
    if let Some(route) = resolve(&cfg, "") {
        let _url = &route.base_url;
        // Reachability anchor so outbound_headers/sniff/append_usage are on the
        // binary's reachable path; Task 6 replaces this stub with real forwarding.
        let _headers = outbound_headers(&route.auth, &HeaderMap::new());
        let mut _acc = UsageAcc::default();
        sniff(&serde_json::Value::Null, &mut _acc);
        if let Some(line) = _acc.finish("", 0) {
            append_usage(std::path::Path::new(""), &line);
        }
    }
    StatusCode::NOT_IMPLEMENTED
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn passthrough_forwards_oauth_bearer_verbatim() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer sk-ant-oat-REAL".parse().unwrap());
        let out = outbound_headers(&Auth::Passthrough, &h);
        assert_eq!(out.get("authorization").unwrap(), "Bearer sk-ant-oat-REAL");
    }

    #[test]
    fn swap_drops_dummy_and_injects_provider_key() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("x-api-key", "sk-no-key-required".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_OPENROUTER".into(),
            scheme: Scheme::Bearer,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("or-REALKEY".into()));
        assert_eq!(out.get("authorization").unwrap(), "Bearer or-REALKEY");
        assert!(
            out.get("x-api-key").is_none(),
            "x-api-key must not be forwarded on a Swap leg"
        );
    }

    #[test]
    fn passthrough_never_injects_a_stored_key() {
        let out = outbound_headers(&Auth::Passthrough, &HeaderMap::new());
        assert!(out.get("authorization").is_none() && out.get("x-api-key").is_none());
    }

    #[test]
    fn swap_scheme_none_drops_dummy_and_injects_no_auth_header() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("x-api-key", "sk-no-key-required".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_LOCAL".into(),
            scheme: Scheme::None,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("local-key".into()));
        assert!(out.get("authorization").is_none());
        assert!(
            out.get("x-api-key").is_none(),
            "x-api-key must not be forwarded on a Swap/None leg"
        );
    }

    #[test]
    fn passthrough_copies_all_anthropic_headers() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer sk-ant-oat-REAL".parse().unwrap());
        h.insert("x-api-key", "sk-ant-key".parse().unwrap());
        h.insert("anthropic-beta", "messages-2023-12-15".parse().unwrap());
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        let out = outbound_headers(&Auth::Passthrough, &h);
        assert_eq!(out.get("authorization").unwrap(), "Bearer sk-ant-oat-REAL");
        assert_eq!(out.get("x-api-key").unwrap(), "sk-ant-key");
        assert_eq!(out.get("anthropic-beta").unwrap(), "messages-2023-12-15");
        assert_eq!(out.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(out.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn swap_keeps_non_auth_anthropic_headers() {
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer sk-no-key-required".parse().unwrap(),
        );
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        let auth = Auth::Swap {
            env: "SPW_KEY_OPENROUTER".into(),
            scheme: Scheme::Bearer,
        };
        let out = outbound_headers_with(&auth, &h, |_| Some("or-REALKEY".into()));
        assert_eq!(out.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(out.get("content-type").unwrap(), "application/json");
        assert_eq!(out.get("authorization").unwrap(), "Bearer or-REALKEY");
    }
}
