//! HTTP forwarding for `HostBridge` (`ConnectionMode::HttpForward`): bearer-routed relay from
//! containers to host-local HTTP MCP servers on the loopback literal. See ADR-063.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::{Method, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Body, Bytes, Frame, Incoming};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Semaphore};
use tokio::time::{Instant, Sleep};

use super::host_bridge::constant_time_eq;

// SSOT-allow: host-local upstream app — the app listens on loopback only, never the bind address
pub(crate) const HOST_LOCAL_UPSTREAM_IP: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// JSON-RPC body the guard maps to "<App> is not running" (502, code -32001).
pub(crate) const HOST_APP_UNAVAILABLE_BODY: &str =
    r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"host_app_unavailable"}}"#;

const DEFAULT_BODY_CAP: usize = 4 * 1024 * 1024;
const DEFAULT_RESPONSE_CAP: usize = 16 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_MAX_CONNECTIONS: usize = 64;
const ACCEPT_BACKOFF_START: Duration = Duration::from_millis(50);
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);

const STRIPPED_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    "content-length",
    "authorization",
    "host",
    "cookie",
    "set-cookie",
    "forwarded",
    "origin",
];

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type RelayBody = BoxBody<Bytes, BoxError>;

/// Host-local target of one route: `127.0.0.1:<port><path>`, labelled `server` in logs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upstream {
    pub port: u16,
    pub path: String,
    pub server: String,
}

/// Bearer → upstream table, shared with the owner and re-read on every request.
pub type RouteTable = Arc<RwLock<HashMap<String, Upstream>>>;

/// Limits and routes of an `HttpForward` bridge; `new` applies the production limits.
#[derive(Clone)]
pub struct HttpForwardConfig {
    pub routes: RouteTable,
    pub body_cap: usize,
    pub response_cap: usize,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub sse_idle_timeout: Duration,
    pub max_connections: usize,
}

impl HttpForwardConfig {
    pub fn new(routes: RouteTable) -> Self {
        Self {
            routes,
            body_cap: DEFAULT_BODY_CAP,
            response_cap: DEFAULT_RESPONSE_CAP,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            sse_idle_timeout: DEFAULT_SSE_IDLE_TIMEOUT,
            max_connections: DEFAULT_MAX_CONNECTIONS,
        }
    }

    fn route_count(&self) -> usize {
        self.routes
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }
}

impl std::fmt::Debug for HttpForwardConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpForwardConfig")
            .field("routes", &self.route_count())
            .field("body_cap", &self.body_cap)
            .field("response_cap", &self.response_cap)
            .field("connect_timeout", &self.connect_timeout)
            .field("request_timeout", &self.request_timeout)
            .field("sse_idle_timeout", &self.sse_idle_timeout)
            .field("max_connections", &self.max_connections)
            .finish()
    }
}

pub(crate) async fn run_http_forward_loop(
    listener: TcpListener,
    config: HttpForwardConfig,
    bridge_name: String,
    mut shutdown_rx: broadcast::Receiver<()>,
) {
    let permits = Arc::new(Semaphore::new(config.max_connections.max(1)));
    let config = Arc::new(config);
    let mut accept_failures: u32 = 0;
    loop {
        let permit = tokio::select! {
            _ = shutdown_rx.recv() => break,
            permit = Arc::clone(&permits).acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => break,
            },
        };
        let stream = tokio::select! {
            _ = shutdown_rx.recv() => break,
            accept_res = listener.accept() => match accept_res {
                Ok((stream, _)) => {
                    accept_failures = 0;
                    stream
                }
                Err(e) => {
                    drop(permit);
                    accept_failures = accept_failures.saturating_add(1);
                    let delay = accept_error_backoff(accept_failures);
                    if accept_failures == 1 {
                        log::warn!(target: "host_bridge", "relay '{bridge_name}' accept failed, backing off: {e}");
                    } else {
                        log::debug!(target: "host_bridge", "relay '{bridge_name}' accept failed again, retrying in {} ms: {e}", delay.as_millis());
                    }
                    tokio::select! {
                        _ = shutdown_rx.recv() => break,
                        _ = tokio::time::sleep(delay) => continue,
                    }
                }
            },
        };
        let config = Arc::clone(&config);
        let name = bridge_name.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = hyper::service::service_fn(move |req| {
                let config = Arc::clone(&config);
                async move { Ok::<_, Infallible>(handle_request(req, &config).await) }
            });
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder.timer(TokioTimer::new());
            if let Err(e) = builder
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                log::debug!(target: "host_bridge", "relay '{name}' connection ended: {e}");
            }
        });
    }
}

fn accept_error_backoff(consecutive_failures: u32) -> Duration {
    let doublings = consecutive_failures.saturating_sub(1).min(16);
    ACCEPT_BACKOFF_START
        .saturating_mul(1 << doublings)
        .min(ACCEPT_BACKOFF_MAX)
}

async fn handle_request(req: Request<Incoming>, config: &HttpForwardConfig) -> Response<RelayBody> {
    let method = req.method().clone();
    let Some(upstream) = match_route(req.headers(), &config.routes) else {
        return plain(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if req.headers().contains_key(header::ORIGIN) {
        return plain(StatusCode::FORBIDDEN, "Forbidden origin");
    }
    if req.uri().path_and_query().map(|pq| pq.as_str()) != Some("/") {
        return plain(StatusCode::NOT_FOUND, "Not Found");
    }
    if !matches!(method, Method::POST | Method::GET | Method::DELETE) {
        let mut resp = plain(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        resp.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, POST, DELETE"));
        return resp;
    }
    if declared_length(req.headers()).is_some_and(|n| n > config.body_cap) {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
    }
    let (parts, body) = req.into_parts();
    let body = match Limited::new(body, config.body_cap).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => {
            return plain(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
        }
        Err(e) => {
            log::debug!(target: "host_bridge", "relay request body read failed: {e}");
            return plain(StatusCode::BAD_REQUEST, "Bad Request");
        }
    };
    let request_bytes = body.len();
    let resp = forward(&parts.method, &parts.headers, body, &upstream, config).await;
    log::debug!(
        target: "host_bridge",
        "relay {} to '{}' answered {} ({request_bytes} B in)",
        parts.method,
        upstream.server,
        resp.status().as_u16()
    );
    resp
}

fn match_route(headers: &HeaderMap, routes: &RouteTable) -> Option<Upstream> {
    let presented = bearer_token(headers)?;
    let table = routes
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut matched: Option<&Upstream> = None;
    for (bearer, upstream) in table.iter() {
        if constant_time_eq(presented, bearer) && matched.is_none() {
            matched = Some(upstream);
        }
    }
    matched.cloned()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

async fn forward(
    method: &Method,
    incoming: &HeaderMap,
    body: Bytes,
    upstream: &Upstream,
    config: &HttpForwardConfig,
) -> Response<RelayBody> {
    let started = Instant::now();
    let request = match build_upstream_request(method, incoming, body, upstream) {
        Ok(r) => r,
        Err(e) => {
            log::warn!(target: "host_bridge", "relay could not build the request for '{}': {e}", upstream.server);
            return plain(StatusCode::BAD_GATEWAY, "Bad Gateway");
        }
    };
    let exchange = async {
        let addr = SocketAddr::from((HOST_LOCAL_UPSTREAM_IP, upstream.port));
        let stream = tokio::time::timeout(config.connect_timeout, TcpStream::connect(addr))
            .await
            .map_err(|_| "connect timed out".to_string())?
            .map_err(|e| format!("connect failed: {e}"))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| format!("handshake failed: {e}"))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        sender
            .send_request(request)
            .await
            .map_err(|e| format!("request failed: {e}"))
    };
    let response = match tokio::time::timeout(config.request_timeout, exchange).await {
        Ok(Ok(r)) => r,
        Ok(Err(reason)) => return host_app_unavailable(&upstream.server, &reason),
        Err(_) => return host_app_unavailable(&upstream.server, "no answer before the deadline"),
    };
    if response.status().is_redirection() {
        log::warn!(
            target: "host_bridge",
            "relay refused a {} redirect from '{}'",
            response.status().as_u16(),
            upstream.server
        );
        return plain(StatusCode::BAD_GATEWAY, "Upstream redirect refused");
    }
    let (parts, body) = response.into_parts();
    let is_sse = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.trim_start().starts_with("text/event-stream"));
    let timing = if is_sse {
        Timing::Idle(config.sse_idle_timeout)
    } else {
        Timing::Deadline(started + config.request_timeout)
    };
    let capped = CappedBody::new(body, config.response_cap, timing, upstream.server.clone());
    let mut resp = Response::new(capped.boxed());
    *resp.status_mut() = parts.status;
    copy_headers(&parts.headers, resp.headers_mut());
    resp
}

fn build_upstream_request(
    method: &Method,
    incoming: &HeaderMap,
    body: Bytes,
    upstream: &Upstream,
) -> Result<Request<Full<Bytes>>, http::Error> {
    let mut request = Request::builder()
        .method(method.clone())
        .uri(upstream.path.as_str())
        .body(Full::new(body))?;
    copy_headers(incoming, request.headers_mut());
    let host = HeaderValue::from_str(&format!("{HOST_LOCAL_UPSTREAM_IP}:{}", upstream.port))
        .map_err(http::Error::from)?;
    request.headers_mut().insert(header::HOST, host);
    Ok(request)
}

fn copy_headers(from: &HeaderMap, to: &mut HeaderMap) {
    let connection_listed: Vec<HeaderName> = from
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for (name, value) in from {
        let lower = name.as_str();
        if STRIPPED_HEADERS.contains(&lower)
            || lower.starts_with("x-forwarded-")
            || connection_listed.contains(name)
        {
            continue;
        }
        to.append(name.clone(), value.clone());
    }
}

fn plain(status: StatusCode, text: &'static str) -> Response<RelayBody> {
    let mut resp = Response::new(full(Bytes::from_static(text.as_bytes())));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

fn host_app_unavailable(server: &str, reason: &str) -> Response<RelayBody> {
    log::info!(target: "host_bridge", "relay could not reach host server '{server}': {reason}");
    let mut resp = Response::new(full(Bytes::from_static(
        HOST_APP_UNAVAILABLE_BODY.as_bytes(),
    )));
    *resp.status_mut() = StatusCode::BAD_GATEWAY;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}

fn full(bytes: Bytes) -> RelayBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

enum Timing {
    Idle(Duration),
    Deadline(Instant),
}

/// Streams the upstream body frame by frame, aborting past the byte cap or the timing bound.
struct CappedBody {
    inner: Incoming,
    remaining: usize,
    idle: Option<Duration>,
    timer: Pin<Box<Sleep>>,
    forwarded: usize,
    server: String,
}

impl CappedBody {
    fn new(inner: Incoming, cap: usize, timing: Timing, server: String) -> Self {
        let (idle, wake_at) = match timing {
            Timing::Idle(d) => (Some(d), Instant::now() + d),
            Timing::Deadline(at) => (None, at),
        };
        Self {
            inner,
            remaining: cap,
            idle,
            timer: Box::pin(tokio::time::sleep_until(wake_at)),
            forwarded: 0,
            server,
        }
    }
}

impl Body for CappedBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    if data.len() > this.remaining {
                        log::warn!(
                            target: "host_bridge",
                            "relay closed the response of '{}' at the size cap after {} B",
                            this.server,
                            this.forwarded
                        );
                        return Poll::Ready(Some(Err(
                            "response exceeded the relay size cap".into()
                        )));
                    }
                    this.remaining -= data.len();
                    this.forwarded += data.len();
                    if let Some(idle) = this.idle {
                        this.timer.as_mut().reset(Instant::now() + idle);
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Box::new(e)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => match this.timer.as_mut().poll(cx) {
                Poll::Ready(()) => {
                    log::info!(
                        target: "host_bridge",
                        "relay closed the response of '{}' on its time bound after {} B",
                        this.server,
                        this.forwarded
                    );
                    Poll::Ready(Some(Err("response exceeded the relay time bound".into())))
                }
                Poll::Pending => Poll::Pending,
            },
        }
    }
}

impl Drop for CappedBody {
    fn drop(&mut self) {
        log::debug!(
            target: "host_bridge",
            "relay response of '{}' finished ({} B out)",
            self.server,
            self.forwarded
        );
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use crate::bridges::host_bridge::{
        AuthScheme, ConnectionHandler, ConnectionMode, HostBridge, HostBridgeConfig, OriginPolicy,
    };
    use futures_util::future::BoxFuture;
    use hyper::client::conn::http1::SendRequest;
    use std::path::PathBuf;

    type UpstreamHandler =
        Arc<dyn Fn(Request<Incoming>) -> BoxFuture<'static, Response<RelayBody>> + Send + Sync>;

    #[derive(Clone, Debug)]
    struct Seen {
        method: Method,
        uri: String,
        headers: HeaderMap,
        body: Bytes,
    }

    type SeenLog = Arc<std::sync::Mutex<Vec<Seen>>>;
    type BodySlot = Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Bytes>>>>;

    struct ChanBody(tokio::sync::mpsc::Receiver<Bytes>);

    impl Body for ChanBody {
        type Data = Bytes;
        type Error = BoxError;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            self.0.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
        }
    }

    fn chan_body() -> (tokio::sync::mpsc::Sender<Bytes>, ChanBody) {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        (tx, ChanBody(rx))
    }

    struct TestRelay {
        bridge: HostBridge,
        routes: RouteTable,
        dir: tempfile::TempDir,
    }

    impl TestRelay {
        fn route(&self, bearer: &str, port: u16, path: &str) {
            self.routes.write().unwrap().insert(
                bearer.to_string(),
                Upstream {
                    port,
                    path: path.to_string(),
                    server: "figma".to_string(),
                },
            );
        }
    }

    const BEARER: &str = "relay-test-bearer-0123456789";

    fn http_forward_config(fwd: HttpForwardConfig, lock_dir: PathBuf) -> HostBridgeConfig {
        HostBridgeConfig::builder("relay-test")
            .http_forward(fwd)
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_dir(lock_dir)
            .lock_body(|ctx| serde_json::json!({ "port": ctx.port }))
            .build()
            .unwrap()
    }

    fn start_relay(tune: impl FnOnce(&mut HttpForwardConfig)) -> TestRelay {
        let routes = RouteTable::default();
        let mut fwd = HttpForwardConfig::new(Arc::clone(&routes));
        tune(&mut fwd);
        let dir = tempfile::tempdir().unwrap();
        let cfg = http_forward_config(fwd, dir.path().join("relay"));
        let mut bridge = HostBridge::new(cfg).unwrap();
        bridge.start_http_forward().unwrap();
        TestRelay {
            bridge,
            routes,
            dir,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    async fn spawn_upstream(handler: UpstreamHandler) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req| {
                        let handler = Arc::clone(&handler);
                        async move { Ok::<_, Infallible>(handler(req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), svc)
                        .await;
                });
            }
        });
        port
    }

    fn recording_echo(seen: SeenLog) -> UpstreamHandler {
        Arc::new(move |req: Request<Incoming>| {
            let seen = Arc::clone(&seen);
            Box::pin(async move {
                let (parts, body) = req.into_parts();
                let body = body.collect().await.unwrap().to_bytes();
                seen.lock().unwrap().push(Seen {
                    method: parts.method,
                    uri: parts.uri.to_string(),
                    headers: parts.headers,
                    body: body.clone(),
                });
                Response::builder()
                    .status(200)
                    .header("content-type", "application/json")
                    .header("mcp-session-id", "sess-1")
                    .header("set-cookie", "track=1")
                    .header("x-upstream", "kept")
                    .body(full(body))
                    .unwrap()
            })
        })
    }

    fn streaming_upstream(slot: BodySlot, content_type: &'static str) -> UpstreamHandler {
        Arc::new(move |req: Request<Incoming>| {
            let slot = Arc::clone(&slot);
            Box::pin(async move {
                drop(req);
                let (tx, body) = chan_body();
                *slot.lock().unwrap() = Some(tx);
                Response::builder()
                    .status(200)
                    .header("content-type", content_type)
                    .body(body.boxed())
                    .unwrap()
            })
        })
    }

    async fn connect<B>(port: u16) -> SendRequest<B>
    where
        B: Body + Send + 'static,
        B::Data: Send,
        B::Error: Into<BoxError>,
    {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        sender
    }

    fn request(method: Method, uri: &str, bearer: Option<&str>) -> http::request::Builder {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", "host.docker.internal");
        if let Some(t) = bearer {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        b
    }

    async fn send(port: u16, req: Request<Full<Bytes>>) -> Response<Incoming> {
        let mut sender = connect::<Full<Bytes>>(port).await;
        sender.send_request(req).await.unwrap()
    }

    async fn body_text(resp: Response<Incoming>) -> String {
        String::from_utf8(
            resp.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .to_vec(),
        )
        .unwrap()
    }

    fn post(bearer: Option<&str>, body: &'static str) -> Request<Full<Bytes>> {
        request(Method::POST, "/", bearer)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from_static(body.as_bytes())))
            .unwrap()
    }

    fn empty(method: Method, uri: &str, bearer: Option<&str>) -> Request<Full<Bytes>> {
        request(method, uri, bearer)
            .body(Full::new(Bytes::new()))
            .unwrap()
    }

    fn free_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn post_json_round_trip_strips_and_sets_headers() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/mcp");
            let req = request(Method::POST, "/", Some(BEARER))
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-06-18")
                .header("mcp-session-id", "sess-1")
                .header("cookie", "c=1")
                .header("forwarded", "for=1.2.3.4")
                .header("x-forwarded-for", "1.2.3.4")
                .header("x-forwarded-host", "evil")
                .header("connection", "keep-alive, x-hop")
                .header("x-hop", "drop-me")
                .header("te", "trailers")
                .header("x-custom", "kept")
                .body(Full::new(Bytes::from_static(
                    br#"{"jsonrpc":"2.0","id":1}"#,
                )))
                .unwrap();
            let resp = send(port, req).await;
            assert_eq!(resp.status(), 200);
            assert_eq!(resp.headers()["mcp-session-id"], "sess-1");
            assert_eq!(resp.headers()["content-type"], "application/json");
            assert_eq!(resp.headers()["x-upstream"], "kept");
            assert!(resp.headers().get("set-cookie").is_none());
            assert_eq!(body_text(resp).await, r#"{"jsonrpc":"2.0","id":1}"#);
        });
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let got = &seen[0];
        assert_eq!(got.method, Method::POST);
        assert_eq!(got.uri, "/mcp");
        assert_eq!(got.body.as_ref(), br#"{"jsonrpc":"2.0","id":1}"#);
        let host = got.headers["host"].to_str().unwrap().to_string();
        assert!(host.starts_with("127.0.0.1:"), "host rewritten: {host}");
        for kept in [
            "content-type",
            "accept",
            "mcp-protocol-version",
            "mcp-session-id",
            "x-custom",
        ] {
            assert!(got.headers.contains_key(kept), "{kept} must pass");
        }
        for stripped in [
            "authorization",
            "cookie",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-hop",
            "te",
        ] {
            assert!(
                !got.headers.contains_key(stripped),
                "{stripped} must be stripped"
            );
        }
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn post_answered_with_sse_streams_events_before_the_end() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let slot = BodySlot::default();
        rt().block_on(async {
            let up =
                spawn_upstream(streaming_upstream(Arc::clone(&slot), "text/event-stream")).await;
            relay.route(BEARER, up, "/mcp");
            let resp = send(port, post(Some(BEARER), "{}")).await;
            assert_eq!(resp.status(), 200);
            assert_eq!(resp.headers()["content-type"], "text/event-stream");
            let mut body = resp.into_body();
            let tx = slot.lock().unwrap().take().unwrap();
            tx.send(Bytes::from_static(b"data: one\n\n")).await.unwrap();
            let first = tokio::time::timeout(Duration::from_secs(5), body.frame())
                .await
                .expect("first event must arrive while the stream is still open")
                .unwrap()
                .unwrap();
            assert_eq!(first.into_data().unwrap().as_ref(), b"data: one\n\n");
            tx.send(Bytes::from_static(b"data: two\n\n")).await.unwrap();
            drop(tx);
            let rest = body.collect().await.unwrap().to_bytes();
            assert_eq!(rest.as_ref(), b"data: two\n\n");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn get_sse_stream_passes_last_event_id() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let slot = BodySlot::default();
        let seen = SeenLog::default();
        let seen_up = Arc::clone(&seen);
        let stream = streaming_upstream(Arc::clone(&slot), "text/event-stream");
        let handler: UpstreamHandler = Arc::new(move |req: Request<Incoming>| {
            seen_up.lock().unwrap().push(Seen {
                method: req.method().clone(),
                uri: req.uri().to_string(),
                headers: req.headers().clone(),
                body: Bytes::new(),
            });
            stream(req)
        });
        rt().block_on(async {
            let up = spawn_upstream(handler).await;
            relay.route(BEARER, up, "/mcp");
            let req = request(Method::GET, "/", Some(BEARER))
                .header("accept", "text/event-stream")
                .header("last-event-id", "41")
                .body(Full::new(Bytes::new()))
                .unwrap();
            let resp = send(port, req).await;
            assert_eq!(resp.status(), 200);
            let mut body = resp.into_body();
            let tx = slot.lock().unwrap().take().unwrap();
            tx.send(Bytes::from_static(b"id: 42\ndata: x\n\n"))
                .await
                .unwrap();
            let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(frame.into_data().unwrap().as_ref(), b"id: 42\ndata: x\n\n");
        });
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, Method::GET);
        assert_eq!(seen[0].uri, "/mcp");
        assert_eq!(seen[0].headers["last-event-id"], "41");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn delete_forwards_the_session_header() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/mcp");
            let req = request(Method::DELETE, "/", Some(BEARER))
                .header("mcp-session-id", "sess-9")
                .body(Full::new(Bytes::new()))
                .unwrap();
            assert_eq!(send(port, req).await.status(), 200);
        });
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].method, Method::DELETE);
        assert_eq!(seen[0].headers["mcp-session-id"], "sess-9");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn body_at_the_cap_passes_and_one_byte_more_is_413() {
        let relay = start_relay(|c| c.body_cap = 1024);
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/");
            let at_cap = request(Method::POST, "/", Some(BEARER))
                .body(Full::new(Bytes::from(vec![b'a'; 1024])))
                .unwrap();
            assert_eq!(send(port, at_cap).await.status(), 200);
            let over = request(Method::POST, "/", Some(BEARER))
                .body(Full::new(Bytes::from(vec![b'a'; 1025])))
                .unwrap();
            assert_eq!(send(port, over).await.status(), 413);
        });
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "an over-cap body never reaches upstream"
        );
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn chunked_body_over_the_cap_is_413() {
        let relay = start_relay(|c| c.body_cap = 1024);
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/");
            let mut sender = connect::<ChanBody>(port).await;
            let (tx, body) = chan_body();
            let req = request(Method::POST, "/", Some(BEARER)).body(body).unwrap();
            let pending = sender.send_request(req);
            tx.send(Bytes::from(vec![b'a'; 600])).await.unwrap();
            let _ = tx.send(Bytes::from(vec![b'a'; 600])).await;
            drop(tx);
            let resp = tokio::time::timeout(Duration::from_secs(5), pending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(resp.status(), 413);
        });
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn keep_alive_connection_serves_two_requests() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/mcp");
            let mut sender = connect::<Full<Bytes>>(port).await;
            for body in ["first", "second"] {
                sender.ready().await.unwrap();
                let resp = sender.send_request(post(Some(BEARER), body)).await.unwrap();
                assert_eq!(resp.status(), 200);
                assert_eq!(body_text(resp).await, body);
            }
        });
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn requests_without_a_matching_bearer_are_401() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/");
            assert_eq!(send(port, post(None, "{}")).await.status(), 401);
            let wrong = post(Some("relay-test-bearer-0123456780"), "{}");
            assert_eq!(send(port, wrong).await.status(), 401);
            let basic = request(Method::POST, "/", None)
                .header("authorization", format!("Basic {BEARER}"))
                .body(Full::new(Bytes::new()))
                .unwrap();
            assert_eq!(send(port, basic).await.status(), 401);
            let lower = request(Method::POST, "/", None)
                .header("authorization", format!("bearer {BEARER}"))
                .body(Full::new(Bytes::new()))
                .unwrap();
            assert_eq!(send(port, lower).await.status(), 200);
        });
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn origin_path_and_method_are_enforced() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/");
            let origin = request(Method::POST, "/", Some(BEARER))
                .header("origin", "https://evil.example")
                .body(Full::new(Bytes::new()))
                .unwrap();
            assert_eq!(send(port, origin).await.status(), 403);
            for uri in ["/x", "/?a=1", "//"] {
                let status = send(port, empty(Method::POST, uri, Some(BEARER)))
                    .await
                    .status();
                assert_eq!(status, 404, "{uri}");
            }
            let resp = send(port, empty(Method::PUT, "/", Some(BEARER))).await;
            assert_eq!(resp.status(), 405);
            assert_eq!(resp.headers()["allow"], "GET, POST, DELETE");
            let no_auth_put = send(port, empty(Method::PUT, "/x", None)).await;
            assert_eq!(no_auth_put.status(), 401, "auth is checked first");
        });
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn unreachable_upstream_is_502_host_app_unavailable() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        relay.route(BEARER, free_port(), "/mcp");
        rt().block_on(async {
            let resp = send(port, post(Some(BEARER), "{}")).await;
            assert_eq!(resp.status(), 502);
            assert_eq!(resp.headers()["content-type"], "application/json");
            let body: serde_json::Value = serde_json::from_str(&body_text(resp).await).unwrap();
            assert_eq!(body["jsonrpc"], "2.0");
            assert_eq!(body["error"]["code"], -32001);
            assert_eq!(body["error"]["message"], "host_app_unavailable");
            assert_eq!(body["id"], serde_json::Value::Null);
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn upstream_redirect_is_502_and_never_followed() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hits_up = Arc::clone(&hits);
        let handler: UpstreamHandler = Arc::new(move |_req| {
            hits_up.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                Response::builder()
                    .status(302)
                    .header("location", "http://example.com/")
                    .body(full(Bytes::new()))
                    .unwrap()
            })
        });
        rt().block_on(async {
            let up = spawn_upstream(handler).await;
            relay.route(BEARER, up, "/");
            let resp = send(port, post(Some(BEARER), "{}")).await;
            assert_eq!(resp.status(), 502);
            assert!(resp.headers().get("location").is_none());
        });
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn response_over_the_cap_is_cut_off() {
        let relay = start_relay(|c| c.response_cap = 1024);
        let port = relay.bridge.port();
        let slot = BodySlot::default();
        rt().block_on(async {
            let up =
                spawn_upstream(streaming_upstream(Arc::clone(&slot), "application/json")).await;
            relay.route(BEARER, up, "/");
            let resp = send(port, post(Some(BEARER), "{}")).await;
            assert_eq!(resp.status(), 200);
            let tx = slot.lock().unwrap().take().unwrap();
            tokio::spawn(async move {
                for _ in 0..8 {
                    if tx.send(Bytes::from(vec![b'x'; 512])).await.is_err() {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
            let mut body = resp.into_body();
            let mut received = 0usize;
            let ended_with_error = loop {
                match tokio::time::timeout(Duration::from_secs(5), body.frame())
                    .await
                    .expect("relay must close the stream, not stall")
                {
                    Some(Ok(frame)) => received += frame.data_ref().map_or(0, |d| d.len()),
                    Some(Err(_)) => break true,
                    None => break false,
                }
            };
            assert!(
                ended_with_error,
                "an over-cap response must not end cleanly"
            );
            assert!(received <= 1024, "forwarded {received} B past the cap");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn silent_upstream_times_out_as_host_app_unavailable() {
        let relay = start_relay(|c| c.request_timeout = Duration::from_millis(300));
        let port = relay.bridge.port();
        rt().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let up = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                let mut held = Vec::new();
                while let Ok((s, _)) = listener.accept().await {
                    held.push(s);
                }
            });
            relay.route(BEARER, up, "/");
            let started = std::time::Instant::now();
            let resp = send(port, post(Some(BEARER), "{}")).await;
            assert_eq!(resp.status(), 502);
            assert!(started.elapsed() < Duration::from_secs(5));
            assert!(body_text(resp).await.contains("host_app_unavailable"));
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn idle_sse_stream_is_closed() {
        let relay = start_relay(|c| c.sse_idle_timeout = Duration::from_millis(200));
        let port = relay.bridge.port();
        let slot = BodySlot::default();
        rt().block_on(async {
            let up =
                spawn_upstream(streaming_upstream(Arc::clone(&slot), "text/event-stream")).await;
            relay.route(BEARER, up, "/");
            let resp = send(port, post(Some(BEARER), "{}")).await;
            let tx = slot.lock().unwrap().take().unwrap();
            tx.send(Bytes::from_static(b"data: a\n\n")).await.unwrap();
            let mut body = resp.into_body();
            assert!(body.frame().await.unwrap().is_ok());
            let next = tokio::time::timeout(Duration::from_secs(5), body.frame())
                .await
                .expect("idle stream must be closed by the relay");
            assert!(!matches!(next, Some(Ok(_))), "no further data after idling");
            drop(tx);
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn route_removed_mid_session_rejects_the_next_request() {
        let relay = start_relay(|_| {});
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/");
            let mut sender = connect::<Full<Bytes>>(port).await;
            let first = sender.send_request(post(Some(BEARER), "a")).await.unwrap();
            assert_eq!(first.status(), 200);
            body_text(first).await;
            relay.routes.write().unwrap().clear();
            sender.ready().await.unwrap();
            let second = sender.send_request(post(Some(BEARER), "b")).await.unwrap();
            assert_eq!(second.status(), 401);
        });
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn lock_lives_in_the_lock_dir_and_stop_removes_it() {
        let mut relay = start_relay(|_| {});
        let lock = relay.bridge.lock_file_path();
        assert!(lock.starts_with(relay.dir.path().join("relay")));
        assert!(lock.exists());
        relay.bridge.stop().unwrap();
        assert!(!lock.exists());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_methods_reject_the_wrong_mode() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = http_forward_config(
            HttpForwardConfig::new(RouteTable::default()),
            dir.path().join("relay"),
        );
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        assert!(bridge.start_endpoint(handler).is_err());
        assert!(bridge.start_pairing(None).is_err());

        let endpoint = HostBridgeConfig::builder("relay-test")
            .endpoint(AuthScheme::Header("x-test"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_dir(dir.path().join("ws"))
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        let mut ws = HostBridge::new(endpoint).unwrap();
        assert!(ws.start_http_forward().is_err());
    }

    #[test]
    fn builder_requires_reject_if_present_and_drops_the_single_token_auth() {
        let err = HostBridgeConfig::builder("relay-test")
            .http_forward(HttpForwardConfig::new(RouteTable::default()))
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .lock_body(|_| serde_json::json!({}))
            .build();
        assert!(err.is_err());
        let cfg = HostBridgeConfig::builder("relay-test")
            .endpoint(AuthScheme::Header("x-test"))
            .http_forward(HttpForwardConfig::new(RouteTable::default()))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        assert!(cfg.auth.is_none());
        assert!(matches!(cfg.mode, ConnectionMode::HttpForward(_)));
    }

    #[test]
    fn debug_never_prints_a_bearer() {
        let routes = RouteTable::default();
        routes.write().unwrap().insert(
            BEARER.to_string(),
            Upstream {
                port: 3845,
                path: "/mcp".into(),
                server: "figma".into(),
            },
        );
        let cfg = HttpForwardConfig::new(routes);
        let dbg = format!("{cfg:?} {:?}", ConnectionMode::HttpForward(cfg.clone()));
        assert!(!dbg.contains(BEARER), "{dbg}");
        assert!(dbg.contains("routes: 1"));
    }

    #[test]
    fn defaults_match_the_relay_limits() {
        let cfg = HttpForwardConfig::new(RouteTable::default());
        assert_eq!(cfg.body_cap, 4 * 1024 * 1024);
        assert_eq!(cfg.response_cap, 16 * 1024 * 1024);
        assert_eq!(cfg.connect_timeout, Duration::from_secs(5));
        assert_eq!(cfg.request_timeout, Duration::from_secs(300));
        assert_eq!(cfg.sse_idle_timeout, Duration::from_secs(120));
        assert_eq!(cfg.max_connections, 64);
    }

    #[test]
    fn accept_errors_back_off_exponentially_up_to_a_second() {
        let schedule: Vec<u128> = (1..=8)
            .map(|n| accept_error_backoff(n).as_millis())
            .collect();
        assert_eq!(schedule, [50, 100, 200, 400, 800, 1000, 1000, 1000]);
        assert_eq!(accept_error_backoff(0), Duration::from_millis(50));
        assert_eq!(accept_error_backoff(u32::MAX), Duration::from_secs(1));
    }

    #[test]
    fn expect_upgrade_and_hop_by_hop_headers_never_reach_the_upstream() {
        let mut from = HeaderMap::new();
        for (name, value) in [
            ("expect", "100-continue"),
            ("upgrade", "websocket"),
            ("connection", "upgrade, x-hop"),
            ("x-hop", "1"),
            ("transfer-encoding", "chunked"),
            ("mcp-session-id", "sess-1"),
        ] {
            from.insert(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        let mut to = HeaderMap::new();
        copy_headers(&from, &mut to);
        let kept: Vec<&str> = to.keys().map(HeaderName::as_str).collect();
        assert_eq!(kept, ["mcp-session-id"]);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn connections_over_the_cap_wait_until_a_slot_frees() {
        let relay = start_relay(|c| c.max_connections = 1);
        let port = relay.bridge.port();
        let seen = SeenLog::default();
        rt().block_on(async {
            let up = spawn_upstream(recording_echo(Arc::clone(&seen))).await;
            relay.route(BEARER, up, "/mcp");
            let holder = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut sender = connect::<Full<Bytes>>(port).await;
            let waiting = sender.send_request(post(Some(BEARER), "{}"));
            tokio::pin!(waiting);
            assert!(
                tokio::time::timeout(Duration::from_millis(400), &mut waiting)
                    .await
                    .is_err(),
                "a connection over the cap must not be served"
            );
            assert!(seen.lock().unwrap().is_empty());
            drop(holder);
            let resp = tokio::time::timeout(Duration::from_secs(5), waiting)
                .await
                .expect("the waiting connection is served once the slot frees")
                .unwrap();
            assert_eq!(resp.status(), 200);
        });
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn bearer_parsing_accepts_only_the_bearer_scheme() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer_token(&h), None);
        h.insert("authorization", HeaderValue::from_static("Bearer abc"));
        assert_eq!(bearer_token(&h), Some("abc"));
        h.insert("authorization", HeaderValue::from_static("BEARER  abc "));
        assert_eq!(bearer_token(&h), Some("abc"));
        h.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(bearer_token(&h), None);
        h.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&h), None);
        h.insert("authorization", HeaderValue::from_static("Bearerabc"));
        assert_eq!(bearer_token(&h), None);
    }

    #[test]
    fn match_route_picks_the_route_of_the_presented_bearer() {
        let routes = RouteTable::default();
        for (bearer, port, server) in [("token-a", 1, "a"), ("token-b", 2, "b")] {
            routes.write().unwrap().insert(
                bearer.to_string(),
                Upstream {
                    port,
                    path: "/".into(),
                    server: server.into(),
                },
            );
        }
        let mut h = HeaderMap::new();
        h.insert("authorization", HeaderValue::from_static("Bearer token-b"));
        assert_eq!(match_route(&h, &routes).unwrap().server, "b");
        h.insert("authorization", HeaderValue::from_static("Bearer token-c"));
        assert!(match_route(&h, &routes).is_none());
        h.insert("authorization", HeaderValue::from_static("Bearer token-"));
        assert!(match_route(&h, &routes).is_none());
    }

    #[test]
    fn declared_length_parses_or_ignores() {
        let mut h = HeaderMap::new();
        assert_eq!(declared_length(&h), None);
        h.insert("content-length", HeaderValue::from_static("12"));
        assert_eq!(declared_length(&h), Some(12));
        h.insert("content-length", HeaderValue::from_static("nope"));
        assert_eq!(declared_length(&h), None);
    }
}
