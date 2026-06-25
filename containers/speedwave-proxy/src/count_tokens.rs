use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

/// Synthetic count_tokens response so Anthropic-protocol clients do not
/// 404-cascade when they probe `/v1/messages/count_tokens`.
///
/// Returns 200 with `{"input_tokens":0}` — no upstream call needed.
pub async fn shim() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        Json(json!({"input_tokens": 0})),
    )
}
