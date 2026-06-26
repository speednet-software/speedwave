use std::sync::Arc;

use axum::{
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

fn build_router(cfg: Arc<Config>) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { ([("content-type", "application/json")], r#"{"status":"ok"}"#) }),
        )
        .route("/v1/messages", post(forward::messages))
        .route("/v1/messages/count_tokens", post(count_tokens::shim))
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

    /// Spawn a minimal mock SSE backend that emits the three Anthropic stream events
    /// needed to exercise the usage sniffer: message_start (input tokens) +
    /// content delta + message_delta (output tokens).
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
