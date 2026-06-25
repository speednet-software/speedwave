use std::sync::Arc;

use axum::{extract::State, http::StatusCode};

use crate::router::{resolve, Auth, Config};

/// Stub — full streaming forward implemented in Task 6.
pub async fn messages(State(cfg): State<Arc<Config>>) -> StatusCode {
    // Route resolution and auth-header injection are wired in Task 6.
    // Reference `base_url` and `auth` here so they are reachable from the
    // binary path until that task lands.
    if let Some(route) = resolve(&cfg, "") {
        let _url = &route.base_url;
        let _auth = matches!(&route.auth, Auth::Passthrough);
    }
    StatusCode::NOT_IMPLEMENTED
}
