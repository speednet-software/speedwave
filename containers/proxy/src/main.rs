use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};

mod config;
mod count_tokens;
mod forward;
mod keys;
mod router;
pub(crate) mod usage;

use config::Config;

/// Header the `claude` container sends with the per-project caller secret.
const CALLER_AUTH_HEADER: &str = "x-speedwave-proxy-auth";

/// Rejects `/v1/*` callers lacking the per-project secret — the proxy shares the
/// network with every worker, which could else relay the real key (confused deputy).
async fn require_caller_auth(
    State(cfg): State<Arc<Config>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(expected) = cfg.caller_token.as_deref() else {
        return Ok(next.run(request).await);
    };
    let presented = headers
        .get(CALLER_AUTH_HEADER)
        .and_then(|v| v.to_str().ok());
    if presented == Some(expected) {
        Ok(next.run(request).await)
    } else {
        log::warn!("rejected /v1 request with missing or invalid caller auth");
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn build_router(cfg: Arc<Config>) -> Router {
    let guarded = Router::new()
        .route("/v1/messages", post(forward::messages))
        .route("/v1/messages/count_tokens", post(count_tokens::shim))
        .route_layer(middleware::from_fn_with_state(
            cfg.clone(),
            require_caller_auth,
        ));
    Router::new()
        .route(
            "/health",
            get(|| async { ([("content-type", "application/json")], r#"{"status":"ok"}"#) }),
        )
        .merge(guarded)
        .with_state(cfg)
}

#[tokio::main]
async fn main() {
    // Default to `info` so swap-leg warnings surface; `RUST_LOG` overrides.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let config_path =
        std::env::var("SPW_CONFIG_PATH").unwrap_or_else(|_| "/config/proxy.json".to_string());
    let cfg = match Config::load_from(std::path::Path::new(&config_path)) {
        Ok(c) => {
            log::info!("loaded {} route(s) from {config_path}", c.routes.len());
            Arc::new(c)
        }
        Err(e) => {
            log::error!("failed to load proxy config from {config_path}: {e}");
            std::process::exit(1);
        }
    };
    let app = build_router(cfg);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:4000")
        .await
        .expect("failed to bind 0.0.0.0:4000");
    axum::serve(listener, app).await.expect("server error");
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use bytes::Bytes;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_config() -> Arc<Config> {
        Arc::new(Config::default())
    }

    #[tokio::test]
    async fn health_returns_status_ok() {
        let app = build_router(test_config());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: Bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    /// Mock SSE backend emitting the three Anthropic events the usage sniffer
    /// needs: message_start (input), content delta, message_delta (output).
    async fn spawn_mock_sse_backend() -> std::net::SocketAddr {
        use axum::response::IntoResponse;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = axum::Router::new().route(
                "/v1/messages",
                axum::routing::post(|| async {
                    let sse = concat!(
                        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"usage\":{\"input_tokens\":10}}}\n\n",
                        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
                        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
                        "data: [DONE]\n\n",
                    );
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                        sse,
                    )
                        .into_response()
                }),
            );
            axum::serve(listener, app).await.unwrap();
        });
        addr
    }

    fn config_pointing_at(addr: &std::net::SocketAddr, usage_path: std::path::PathBuf) -> Config {
        use crate::router::{Auth, Route};
        Config {
            routes: vec![Route {
                prefix: "local".to_string(),
                base_url: format!("http://{addr}"),
                auth: Auth::Swap {
                    env: "SPW_KEY_LOCAL".to_string(),
                    scheme: crate::router::Scheme::None,
                },
                provider_kind: "local".to_string(),
                provider_id: "local".to_string(),
            }],
            usage_path,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn relays_stream_and_appends_one_usage_line() {
        let usage_dir = tempfile::tempdir().unwrap();
        let usage_path = usage_dir.path().join("usage.jsonl");

        let addr = spawn_mock_sse_backend().await;
        // Give the listener a moment to be ready.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cfg = Arc::new(config_pointing_at(&addr, usage_path.clone()));
        let app = build_router(cfg);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"model":"local/x","stream":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        // Drain the body to let the relay complete.
        let _ = resp.into_body().collect().await.unwrap();

        // Give the usage writer a tick to finish.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let contents = std::fs::read_to_string(&usage_path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(
            lines.len(),
            1,
            "expected exactly one usage line, got: {lines:?}"
        );
        assert!(
            lines[0].contains("\"completion_tokens\":"),
            "usage line must contain completion_tokens: {}",
            lines[0]
        );
        let parsed: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert!(
            parsed["completion_tokens"].as_u64().unwrap_or(0) > 0,
            "completion_tokens must be non-zero: {}",
            lines[0]
        );
    }

    #[tokio::test]
    async fn v1_rejected_without_caller_token_when_configured() {
        let cfg = Arc::new(Config {
            caller_token: Some("secret-abc".to_string()),
            ..Config::default()
        });
        let app = build_router(cfg);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .body(Body::from(r#"{"model":"local/x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 401, "missing caller auth must be rejected");
    }

    #[tokio::test]
    async fn v1_rejected_with_wrong_caller_token() {
        let cfg = Arc::new(Config {
            caller_token: Some("secret-abc".to_string()),
            ..Config::default()
        });
        let app = build_router(cfg);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header(CALLER_AUTH_HEADER, "wrong")
                    .body(Body::from(r#"{"model":"local/x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn health_needs_no_caller_token() {
        let cfg = Arc::new(Config {
            caller_token: Some("secret-abc".to_string()),
            ..Config::default()
        });
        let app = build_router(cfg);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "health probe must not require auth");
    }

    #[tokio::test]
    async fn v1_allowed_with_correct_caller_token() {
        let usage_dir = tempfile::tempdir().unwrap();
        let addr = spawn_mock_sse_backend().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let mut cfg = config_pointing_at(&addr, usage_dir.path().join("usage.jsonl"));
        cfg.caller_token = Some("secret-abc".to_string());
        let app = build_router(Arc::new(cfg));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("content-type", "application/json")
                    .header(CALLER_AUTH_HEADER, "secret-abc")
                    .body(Body::from(r#"{"model":"local/x","stream":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "correct caller token must pass");
    }

    #[tokio::test]
    async fn count_tokens_shim_returns_200_with_zero_input_tokens() {
        let app = build_router(test_config());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages/count_tokens")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"model":"claude-opus-4-8","messages":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: Bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["input_tokens"], 0);
    }
}
