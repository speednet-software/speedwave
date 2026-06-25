use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

mod config;
mod count_tokens;
mod forward;

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
    let cfg = Arc::new(Config::default());
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
}
