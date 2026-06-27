use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

/// Synthetic count_tokens 200 (`{"input_tokens":0}`) so Anthropic-protocol
/// clients don't 404-cascade probing `/v1/messages/count_tokens`.
pub async fn shim() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        Json(json!({"input_tokens": 0})),
    )
}
