//! IDE Bridge — pairs Claude Code with a local IDE. Endpoint mode of
//! [`HostBridge`]; see ADR-063 and the original IDE Bridge design.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;

use serde::{Deserialize, Serialize};

use super::host_bridge::{
    AuthScheme, ConnectionContext, ConnectionHandler, HostBridge, HostBridgeConfig,
    LockBodyContext, OriginPolicy, SubprotocolPolicy,
};

// Re-export internals used by tests (and historical callers expecting
// them through `crate::ide_bridge::*`).
#[cfg(test)]
pub(crate) use super::host_bridge::constant_time_eq;
pub(crate) use super::host_bridge::AuthState;

/// Header name Claude Code uses to authenticate with the IDE Bridge.
pub(crate) const IDE_BRIDGE_AUTH_HEADER: &str = "x-claude-code-ide-authorization";
/// Display name written into the IDE Bridge lock file.
pub(crate) const IDE_BRIDGE_DISPLAY_NAME: &str = "Speedwave";

// ---------------------------------------------------------------------------
// Lock file schema — Claude Code derives the port from the FILENAME
// (`12345.lock` → port 12345); no `wsUrl` / `port` field is required in
// the JSON. PID must be alive *inside* the container — we hard-code 1
// (init), the only PID guaranteed to be alive in the container PID
// namespace.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct IdeLockFile {
    pub pid: u32,
    #[serde(rename = "workspaceFolders")]
    pub workspace_folders: Vec<String>,
    #[serde(rename = "ideName")]
    pub ide_name: String,
    pub transport: String,
    #[serde(rename = "runningInWindows")]
    pub running_in_windows: bool,
    #[serde(rename = "authToken")]
    pub auth_token: String,
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 protocol types (MCP layer)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct JsonRpcRequest {
    /// Protocol version — required by JSON-RPC 2.0 but unused after parsing.
    #[serde(rename = "jsonrpc")]
    _jsonrpc: String,
    pub method: String,
    pub params: Option<serde_json::Value>,
    pub id: Option<serde_json::Value>,
}

#[derive(Serialize, Debug)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    pub id: serde_json::Value,
}

#[derive(Serialize, Debug)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

pub(crate) fn jsonrpc_success(id: serde_json::Value, result: serde_json::Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        result: Some(result),
        error: None,
        id,
    }
}

pub(crate) fn jsonrpc_error(id: serde_json::Value, code: i32, message: &str) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
        id,
    }
}

pub(crate) fn jsonrpc_method_not_found(id: serde_json::Value) -> JsonRpcResponse {
    jsonrpc_error(id, -32601, "Method not found")
}

pub(crate) fn jsonrpc_parse_error() -> JsonRpcResponse {
    jsonrpc_error(serde_json::Value::Null, -32700, "Parse error")
}

// ---------------------------------------------------------------------------
// MCP tools/list — 12 IDE tools that Claude discovers via MCP
// ---------------------------------------------------------------------------

fn mcp_tools_list() -> serde_json::Value {
    use serde_json::json;
    json!({ "tools": [
        {
            "name": "openFile",
            "description": "Opens a file in the editor with optional text selection",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Path to the file to open" },
                    "preview": { "type": "boolean", "description": "Open in preview mode" },
                    "startText": { "type": "string", "description": "Text to start selection at" },
                    "endText": { "type": "string", "description": "Text to end selection at" },
                    "selectToEndOfLine": { "type": "boolean" },
                    "makeFrontmost": { "type": "boolean" }
                },
                "required": ["filePath"]
            }
        },
        {
            "name": "openDiff",
            "description": "Opens a diff view for a file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_file_path": { "type": "string" },
                    "new_file_path": { "type": "string" },
                    "new_file_contents": { "type": "string" },
                    "tab_name": { "type": "string" }
                }
            }
        },
        {
            "name": "getDiagnostics",
            "description": "Returns language diagnostics (errors, warnings) from the IDE",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "uri": { "type": "string", "description": "File URI, or omit for all files" }
                }
            }
        },
        {
            "name": "close_tab",
            "description": "Closes a specific editor tab",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_name": { "type": "string" }
                },
                "required": ["tab_name"]
            }
        },
        {
            "name": "closeAllDiffTabs",
            "description": "Closes all open diff tabs",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "getOpenEditors",
            "description": "Returns all currently open editor tabs",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "getWorkspaceFolders",
            "description": "Returns workspace folders open in the IDE",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "getCurrentSelection",
            "description": "Gets the text selection in the active editor",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "getLatestSelection",
            "description": "Gets the most recent text selection",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "checkDocumentDirty",
            "description": "Checks if a document has unsaved changes",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string" }
                },
                "required": ["filePath"]
            }
        },
        {
            "name": "saveDocument",
            "description": "Saves a document",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string" }
                },
                "required": ["filePath"]
            }
        },
        {
            "name": "executeCode",
            "description": "Executes code in a Jupyter kernel",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string" }
                },
                "required": ["code"]
            }
        }
    ]})
}

// ---------------------------------------------------------------------------
// MCP tools/call — stub responses when no upstream IDE is configured
// ---------------------------------------------------------------------------

fn mcp_tool_result(text: &str) -> serde_json::Value {
    use serde_json::json;
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

fn mcp_tool_error(text: &str) -> serde_json::Value {
    use serde_json::json;
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true
    })
}

fn dispatch_tool_call(name: &str, _args: Option<&serde_json::Value>) -> serde_json::Value {
    use serde_json::json;
    match name {
        "openFile" => mcp_tool_error(
            "No IDE connected — file not opened. Connect an IDE in Speedwave Health Dashboard.",
        ),
        "openDiff" => mcp_tool_error("No IDE connected — diff not opened."),
        "getCurrentSelection" => mcp_tool_result(&json!({"selection": null}).to_string()),
        "getLatestSelection" => mcp_tool_result(&json!({"selection": null}).to_string()),
        "getOpenEditors" => mcp_tool_result(&json!({"editors": []}).to_string()),
        "getWorkspaceFolders" => mcp_tool_result(&json!({"folders": ["/workspace"]}).to_string()),
        "getDiagnostics" => mcp_tool_result(&json!({"diagnostics": []}).to_string()),
        "checkDocumentDirty" => mcp_tool_result(&json!({"dirty": false}).to_string()),
        "saveDocument" => mcp_tool_error("No IDE connected — document not saved."),
        "close_tab" => mcp_tool_error("No IDE connected."),
        "closeAllDiffTabs" => mcp_tool_error("No IDE connected."),
        "executeCode" => mcp_tool_error("executeCode is not supported in stub mode"),
        _ => {
            log::warn!("unknown tool {}", name);
            mcp_tool_error(&format!("unknown tool: {}", name))
        }
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher (MCP method handler)
// ---------------------------------------------------------------------------

pub(crate) fn dispatch_method(
    method: &str,
    params: Option<&serde_json::Value>,
    id: serde_json::Value,
) -> JsonRpcResponse {
    use serde_json::json;
    match method {
        "initialize" => {
            let client_version = params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05");
            log::debug!("MCP initialize (protocol {})", client_version);
            jsonrpc_success(
                id,
                json!({
                    "protocolVersion": client_version,
                    "capabilities": {
                        "tools": { "listChanged": true }
                    },
                    "serverInfo": {
                        "name": IDE_BRIDGE_DISPLAY_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }
        "tools/list" => {
            log::debug!("tools/list");
            jsonrpc_success(id, mcp_tools_list())
        }
        "tools/call" => {
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let arguments = params.and_then(|p| p.get("arguments"));
            log::debug!("tools/call {}", name);
            jsonrpc_success(id, dispatch_tool_call(name, arguments))
        }
        "ping" => jsonrpc_success(id, json!({})),
        "notifications/initialized" | "ide_connected" => {
            log::debug!("received {}", method);
            jsonrpc_success(id, json!({}))
        }
        _ => {
            log::warn!("unknown method {}", method);
            jsonrpc_method_not_found(id)
        }
    }
}

pub(crate) fn handle_jsonrpc_message(text: &str) -> Option<JsonRpcResponse> {
    let req: JsonRpcRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(_) => return Some(jsonrpc_parse_error()),
    };
    let id = req.id.clone().unwrap_or(serde_json::Value::Null);
    let is_notification = req.id.is_none();
    let resp = dispatch_method(&req.method, req.params.as_ref(), id);
    if is_notification {
        None
    } else {
        Some(resp)
    }
}

// ---------------------------------------------------------------------------
// Upstream IDE — proxy target read from `~/.claude/ide/<port>.lock`
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct UpstreamIde {
    pub ide_name: String,
    pub port: u16,
    pub auth_token: String,
}

impl std::fmt::Debug for UpstreamIde {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpstreamIde")
            .field("ide_name", &self.ide_name)
            .field("port", &self.port)
            .field("auth_token", &"***REDACTED***")
            .finish()
    }
}

/// Callback invoked on IDE Bridge events (e.g. "connected", "stub_call").
/// Parameters: `(event_kind, detail_message)`.
pub type EventCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

// ---------------------------------------------------------------------------
// IdeBridge — thin facade on top of HostBridge in Endpoint mode
// ---------------------------------------------------------------------------

pub struct IdeBridge {
    /// `Some` in production (created via `new()`); `None` in test-only
    /// `new_with_paths()`, which exercises lock-file helpers without a
    /// real listener.
    inner: Option<HostBridge>,

    // Mirrored from `inner` (in production) or supplied by the caller
    // (in `new_with_paths`). Tests read these directly via field access.
    _tcp_port: u16,
    lock_file_path: PathBuf,
    /// `_`-prefix because the field is only read inside `#[cfg(test)]
    /// fn write_lock_file` — no production read site exists, but tests
    /// need it via field access. Mirrors the `_path`/`_query`/… pattern
    /// in `bridges::host_bridge::ConnectionContext`.
    _auth: Arc<Mutex<AuthState>>,

    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_tx: tokio::sync::broadcast::Sender<()>,
    event_cb: Option<EventCallback>,
}

impl IdeBridge {
    pub fn new() -> anyhow::Result<Self> {
        let config = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header(IDE_BRIDGE_AUTH_HEADER))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .subprotocol(SubprotocolPolicy { accepted: &["mcp"] })
            .lock_body(|ctx: LockBodyContext<'_>| {
                let lock = IdeLockFile {
                    pid: 1,
                    workspace_folders: vec!["/workspace".to_string()],
                    ide_name: IDE_BRIDGE_DISPLAY_NAME.to_string(),
                    transport: "ws".to_string(),
                    running_in_windows: cfg!(windows),
                    auth_token: ctx.auth_token.to_string(),
                };
                serde_json::to_value(&lock).unwrap_or(serde_json::Value::Null)
            })
            .build()?;

        let inner = HostBridge::new(config)?;
        let tcp_port = inner.port();
        let lock_file_path = inner.lock_file_path().to_path_buf();
        // Use the same UUID as the inner bridge so both layers validate
        // the same token. (HostBridge mints it; we re-wrap it for callers
        // that still expect the legacy AuthState handle.)
        let auth = Arc::new(Mutex::new(AuthState::new(inner.auth_token())));
        let (upstream_changed_tx, _) = tokio::sync::broadcast::channel(4);
        Ok(Self {
            inner: Some(inner),
            _tcp_port: tcp_port,
            lock_file_path,
            _auth: auth,
            upstream: Arc::new(Mutex::new(None)),
            upstream_changed_tx,
            event_cb: None,
        })
    }

    #[cfg(test)]
    pub fn upstream_info(&self) -> Option<(String, u16)> {
        self.upstream
            .lock()
            .ok()?
            .as_ref()
            .map(|u| (u.ide_name.clone(), u.port))
    }

    pub fn set_event_callback(&mut self, cb: EventCallback) {
        self.event_cb = Some(cb);
    }

    /// Read the auth token from `~/.claude/ide/<port>.lock` and store the
    /// proxy target. Existing WebSocket connections are signalled to
    /// reconnect so they pick up the new upstream.
    pub fn set_upstream(&self, ide_name: String, port: u16) -> anyhow::Result<()> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
        let lock_path = home
            .join(".claude")
            .join("ide")
            .join(format!("{}.lock", port));
        let contents = std::fs::read_to_string(&lock_path)
            .map_err(|e| anyhow::anyhow!("cannot read lock file {}: {}", lock_path.display(), e))?;
        let v: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| anyhow::anyhow!("invalid lock file JSON: {e}"))?;
        let auth_token = v
            .get("authToken")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow::anyhow!("authToken missing in lock file"))?
            .to_string();

        let upstream = UpstreamIde {
            ide_name,
            port,
            auth_token,
        };
        let mut guard = self
            .upstream
            .lock()
            .map_err(|e| anyhow::anyhow!("upstream mutex poisoned: {e}"))?;
        *guard = Some(upstream);
        drop(guard);
        let _ = self.upstream_changed_tx.send(());
        Ok(())
    }

    pub fn clear_upstream(&self) {
        match self.upstream.lock() {
            Ok(mut guard) => *guard = None,
            Err(e) => {
                log::warn!("upstream mutex poisoned during clear, recovering: {e}");
                *e.into_inner() = None;
            }
        }
        let _ = self.upstream_changed_tx.send(());
    }

    /// Test-only constructor for tests that write lock files directly
    /// without a live listener. Does **not** spin up `HostBridge`.
    #[cfg(test)]
    pub(crate) fn new_with_paths(auth_token: &str, lock_file_path: PathBuf, tcp_port: u16) -> Self {
        let (upstream_changed_tx, _) = tokio::sync::broadcast::channel(4);
        Self {
            inner: None,
            _tcp_port: tcp_port,
            lock_file_path,
            _auth: Arc::new(Mutex::new(AuthState::new(auth_token.to_string()))),
            upstream: Arc::new(Mutex::new(None)),
            upstream_changed_tx,
            event_cb: None,
        }
    }

    /// Start the bridge: bind, write lock file, accept connections,
    /// proxy to the configured upstream IDE (or use stubs).
    pub fn start(&mut self) -> anyhow::Result<()> {
        let inner = self.inner.as_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "IdeBridge::start() requires inner HostBridge (test-only constructor cannot start)"
            )
        })?;

        let upstream = self.upstream.clone();
        let upstream_changed_tx = self.upstream_changed_tx.clone();
        let event_cb = self.event_cb.clone();

        let handler: ConnectionHandler = Arc::new(move |ws, ctx| {
            let upstream = upstream.clone();
            let upstream_rx = upstream_changed_tx.subscribe();
            let event_cb = event_cb.clone();
            Box::pin(async move {
                handle_authenticated_connection(ws, upstream, upstream_rx, event_cb, ctx).await
            })
        });

        inner.start_endpoint(handler)
    }

    /// Test-only helper: write the lock file synchronously (production
    /// path delegates this to HostBridge in `start()`).
    #[cfg(test)]
    pub(crate) fn write_lock_file(&self) -> anyhow::Result<()> {
        write_lock_file_static(&self.lock_file_path, &self._auth)
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut inner) = self.inner.take() {
            inner.stop()?;
        } else {
            match std::fs::remove_file(&self.lock_file_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).context("removing lock file"),
            }
        }
        Ok(())
    }
}

impl Drop for IdeBridge {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

fn emit_event(cb: &Option<EventCallback>, kind: &str, detail: &str) {
    if let Some(cb) = cb {
        cb(kind, detail);
    }
}

// ---------------------------------------------------------------------------
// Connection handler: already authenticated by HostBridge → choose proxy
// vs stub based on upstream selection.
// ---------------------------------------------------------------------------

async fn handle_authenticated_connection(
    ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_rx: tokio::sync::broadcast::Receiver<()>,
    event_cb: Option<EventCallback>,
    ctx: ConnectionContext,
) {
    log::debug!(
        target: "ide_bridge",
        "{} accepted connection from {}",
        ctx.bridge_name,
        ctx.peer_addr
    );
    emit_event(&event_cb, "connected", "Claude WebSocket connected");
    let upstream_opt = upstream.lock().ok().and_then(|g| g.clone());
    if let Some(up) = upstream_opt {
        proxy_to_upstream(ws, up, upstream_changed_rx, event_cb.clone()).await;
    } else {
        handle_with_stubs(ws, upstream_changed_rx, event_cb.clone()).await;
    }
    emit_event(&event_cb, "disconnected", "Claude WebSocket closed");
}

/// Transparent bidirectional proxy: forwards every message between
/// Claude and the real IDE.
async fn proxy_to_upstream<S>(
    claude_ws: tokio_tungstenite::WebSocketStream<S>,
    up: UpstreamIde,
    mut upstream_changed_rx: tokio::sync::broadcast::Receiver<()>,
    event_cb: Option<EventCallback>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let url = format!("ws://127.0.0.1:{}/", up.port);
    let auth_header_value = match up.auth_token.parse::<http::HeaderValue>() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("invalid auth token for upstream: {e}");
            return;
        }
    };
    let mut req = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => {
            log::warn!("invalid upstream URL: {e}");
            return;
        }
    };
    req.headers_mut()
        .insert(IDE_BRIDGE_AUTH_HEADER, auth_header_value);
    req.headers_mut().insert(
        "sec-websocket-protocol",
        http::HeaderValue::from_static("mcp"),
    );

    let ide_ws = match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            log::warn!("cannot connect to {} (port {}): {e}", up.ide_name, up.port);
            return;
        }
    };

    let (mut claude_write, mut claude_read) = claude_ws.split();
    let (mut ide_write, mut ide_read) = ide_ws.split();

    let (ide_tx, mut ide_rx) = tokio::sync::mpsc::channel::<Message>(32);

    let ide_tx_claude = ide_tx.clone();
    let claude_to_ide = async {
        while let Ok(Some(Ok(m))) =
            tokio::time::timeout(std::time::Duration::from_secs(120), claude_read.next()).await
        {
            if ide_tx_claude.send(m).await.is_err() {
                break;
            }
        }
    };

    let ide_tx_heartbeat = ide_tx;
    let heartbeat = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            if ide_tx_heartbeat
                .send(Message::Ping(vec![].into()))
                .await
                .is_err()
            {
                break;
            }
        }
    };

    let ide_writer_event_cb = event_cb;
    let ide_writer_ide_name = up.ide_name;
    let ide_writer = async {
        while let Some(msg) = ide_rx.recv().await {
            if ide_write.send(msg).await.is_err() {
                emit_event(
                    &ide_writer_event_cb,
                    "upstream_lost",
                    &format!("{} unreachable (write failed)", ide_writer_ide_name),
                );
                break;
            }
        }
    };

    let ide_to_claude = async {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(120), ide_read.next()).await {
                Ok(Some(Ok(Message::Close(frame)))) => {
                    let _ = claude_write.send(Message::Close(frame)).await;
                    break;
                }
                Ok(Some(Ok(m))) => {
                    if claude_write.send(m).await.is_err() {
                        break;
                    }
                }
                Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
            }
        }
    };

    let upstream_changed = async {
        let _ = upstream_changed_rx.recv().await;
        log::info!("upstream changed, closing proxy connection");
    };
    tokio::select! {
        _ = async { tokio::join!(claude_to_ide, ide_to_claude, ide_writer, heartbeat) } => {}
        _ = upstream_changed => {}
    }
}

/// Stub handler used when no upstream IDE is selected.
async fn handle_with_stubs<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    mut upstream_changed_rx: tokio::sync::broadcast::Receiver<()>,
    event_cb: Option<EventCallback>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    loop {
        tokio::select! {
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) {
                            if req.get("method").and_then(|m| m.as_str()) == Some("tools/call") {
                                let tool_name = req.get("params")
                                    .and_then(|p| p.get("name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("unknown");
                                emit_event(&event_cb, "stub_call", &format!("{} (no IDE connected)", tool_name));
                            }
                        }
                        if let Some(resp) = handle_jsonrpc_message(&text) {
                            if let Ok(json) = serde_json::to_string(&resp) {
                                let _ = ws.send(Message::Text(json.into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            _ = upstream_changed_rx.recv() => {
                log::info!("upstream changed, closing stub connection");
                let _ = ws.send(Message::Close(None)).await;
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy test-only helpers
// ---------------------------------------------------------------------------
//
// The pre-HostBridge implementation exposed `run_websocket_on_tcp` and a
// standalone lock-file writer. Several integration tests still hit them
// directly; we keep them gated behind `#[cfg(test)]` so production code
// only ever goes through HostBridge.

#[cfg(test)]
fn find_available_port() -> anyhow::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

#[cfg(test)]
fn write_lock_file_static(
    path: &std::path::Path,
    auth: &Arc<Mutex<AuthState>>,
) -> anyhow::Result<()> {
    let lock_dir = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("invalid lock file path"))?;
    super::host_bridge::ensure_lock_dir(lock_dir)?;
    let auth_guard = auth
        .lock()
        .map_err(|e| anyhow::anyhow!("auth mutex poisoned: {e}"))?;
    let lock = build_ide_lock_file(auth_guard.token());
    let body = serde_json::to_value(&lock)?;
    super::host_bridge::write_lock_file_atomic(path, &body)
}

#[cfg(test)]
fn build_ide_lock_file(auth_token: &str) -> IdeLockFile {
    IdeLockFile {
        pid: 1,
        workspace_folders: vec!["/workspace".to_string()],
        ide_name: IDE_BRIDGE_DISPLAY_NAME.to_string(),
        transport: "ws".to_string(),
        running_in_windows: cfg!(windows),
        auth_token: auth_token.to_string(),
    }
}

/// Test-only async accept loop equivalent to the pre-HostBridge code
/// path. Several integration tests spin this up directly to exercise
/// proxy/stub behaviour without HostBridge's lifecycle.
#[cfg(test)]
pub(crate) async fn run_websocket_on_tcp(
    std_listener: std::net::TcpListener,
    port: u16,
    auth: Arc<Mutex<AuthState>>,
    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_tx: tokio::sync::broadcast::Sender<()>,
    event_cb: Option<EventCallback>,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) {
    if let Err(e) = std_listener.set_nonblocking(true) {
        log::error!("failed to set non-blocking: {e}");
        return;
    }
    let listener = match tokio::net::TcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(e) => {
            log::error!("failed to convert TCP listener: {e}");
            return;
        }
    };
    log::info!("test bridge listening on TCP 127.0.0.1:{port}");
    loop {
        tokio::select! {
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        let auth = auth.clone();
                        let upstream = upstream.clone();
                        let upstream_changed_rx = upstream_changed_tx.subscribe();
                        let event_cb = event_cb.clone();
                        tokio::spawn(handle_test_connection(
                            stream, auth, upstream, upstream_changed_rx, event_cb,
                        ));
                    }
                    Err(e) => log::error!("TCP accept error: {e}"),
                }
            }
            _ = shutdown_rx.recv() => break,
        }
    }
}

#[cfg(test)]
async fn handle_test_connection<S>(
    stream: S,
    auth: Arc<Mutex<AuthState>>,
    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_rx: tokio::sync::broadcast::Receiver<()>,
    event_cb: Option<EventCallback>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    let auth_clone = auth.clone();
    let ws_stream =
        tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| {
            if req.headers().get("origin").is_some() {
                return Err(http::Response::builder()
                    .status(http::StatusCode::FORBIDDEN)
                    .body(Some("Origin header not allowed".to_string()))
                    .unwrap_or_else(|_| http::Response::new(Some("Forbidden".to_string()))));
            }
            let token = req
                .headers()
                .get(IDE_BRIDGE_AUTH_HEADER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let authorized = auth_clone
                .lock()
                .map(|a| a.validate(token))
                .unwrap_or(false);
            if authorized {
                let mut resp = resp;
                if req
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.split(',').any(|p| p.trim() == "mcp"))
                {
                    resp.headers_mut().insert(
                        "sec-websocket-protocol",
                        http::HeaderValue::from_static("mcp"),
                    );
                }
                Ok(resp)
            } else {
                Err(http::Response::builder()
                    .status(http::StatusCode::UNAUTHORIZED)
                    .body(Some("Unauthorized".to_string()))
                    .unwrap_or_else(|_| http::Response::new(Some("Unauthorized".to_string()))))
            }
        })
        .await;

    let ws = match ws_stream {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("WebSocket handshake failed: {e}");
            emit_event(&event_cb, "auth_failed", &format!("handshake failed: {e}"));
            return;
        }
    };

    emit_event(&event_cb, "connected", "Claude WebSocket connected");

    let upstream_opt = upstream.lock().ok().and_then(|g| g.clone());
    if let Some(up) = upstream_opt {
        proxy_to_upstream(ws, up, upstream_changed_rx, event_cb.clone()).await;
    } else {
        handle_with_stubs(ws, upstream_changed_rx, event_cb.clone()).await;
    }

    emit_event(&event_cb, "disconnected", "Claude WebSocket closed");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{
        dispatch_method, find_available_port, handle_jsonrpc_message, jsonrpc_error,
        jsonrpc_parse_error, jsonrpc_success, AuthState, IdeBridge, IdeLockFile, JsonRpcRequest,
    };

    #[test]
    fn test_find_available_port() {
        let port = find_available_port().unwrap();
        assert!(port > 0);
    }

    #[test]
    fn test_auth_state_valid_token() {
        let auth = AuthState::new("test-token".to_string());
        assert!(auth.validate("test-token"));
    }

    #[test]
    fn test_auth_state_invalid_token() {
        let auth = AuthState::new("test-token".to_string());
        assert!(!auth.validate("wrong-token"));
    }

    #[test]
    fn test_auth_state_repeated_failures_dont_lock_out() {
        let auth = AuthState::new("test-token".to_string());
        for _ in 0..100 {
            auth.validate("wrong");
        }
        assert!(auth.validate("test-token"));
    }

    #[test]
    fn test_lock_file_serialization() {
        let lock = IdeLockFile {
            pid: 999,
            workspace_folders: vec!["/workspace".to_string()],
            ide_name: "Speedwave".to_string(),
            transport: "ws".to_string(),
            running_in_windows: false,
            auth_token: "abc-123".to_string(),
        };
        let json = serde_json::to_string(&lock).unwrap();
        assert!(json.contains("\"authToken\""));
        assert!(json.contains("\"workspaceFolders\""));
        assert!(json.contains("\"ideName\""));
        assert!(json.contains("\"Speedwave\""));
        assert!(json.contains("\"transport\""));
        assert!(json.contains("\"ws\""));
        assert!(json.contains("\"runningInWindows\""));
        assert!(
            !json.contains("\"wsUrl\""),
            "wsUrl must not be in lock file — Claude Code ignores it"
        );
        assert!(
            !json.contains("\"port\""),
            "port must not be in lock file — Claude derives it from filename"
        );
    }

    #[test]
    fn test_lock_file_deserialization() {
        let json = r#"{
            "pid": 42,
            "workspaceFolders": ["/workspace"],
            "ideName": "Speedwave",
            "transport": "ws",
            "runningInWindows": false,
            "authToken": "uuid-here"
        }"#;
        let lock: IdeLockFile = serde_json::from_str(json).unwrap();
        assert_eq!(lock.auth_token, "uuid-here");
        assert_eq!(lock.workspace_folders, vec!["/workspace"]);
        assert_eq!(lock.pid, 42);
        assert_eq!(lock.ide_name, "Speedwave");
        assert_eq!(lock.transport, "ws");
        assert!(!lock.running_in_windows);
    }

    #[test]
    fn test_jsonrpc_request_with_id() {
        let json =
            r#"{"jsonrpc":"2.0","method":"openFile","params":{"path":"/foo/bar.rs"},"id":1}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "openFile");
        assert_eq!(req.id, Some(serde_json::json!(1)));
        let path = req
            .params
            .unwrap()
            .get("path")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(path, "/foo/bar.rs");
    }

    #[test]
    fn test_jsonrpc_request_notification_no_id() {
        let json = r#"{"jsonrpc":"2.0","method":"openFile","params":{"path":"/foo/bar.rs"}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "openFile");
        assert_eq!(req.id, None);
    }

    #[test]
    fn test_jsonrpc_request_string_id() {
        let json = r#"{"jsonrpc":"2.0","method":"openFile","id":"abc"}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, Some(serde_json::json!("abc")));
    }

    #[test]
    fn test_jsonrpc_success_serialization() {
        let resp = jsonrpc_success(serde_json::json!(1), serde_json::json!({"ok": true}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn test_jsonrpc_error_serialization() {
        let resp = jsonrpc_error(serde_json::json!(1), -32601, "Method not found");
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"error\""));
        assert!(json.contains("\"code\":-32601"));
        assert!(!json.contains("\"result\""));
    }

    #[test]
    fn test_jsonrpc_parse_error_has_null_id() {
        let resp = jsonrpc_parse_error();
        assert_eq!(resp.id, serde_json::Value::Null);
        assert_eq!(resp.error.unwrap().code, -32700);
    }

    #[test]
    fn test_dispatch_initialize_returns_mcp_response() {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "claude-code", "version": "0.1.0"},
            "capabilities": {}
        });
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(1));
        assert!(resp.result.is_some());
        let result = resp.result.unwrap();
        assert_eq!(result["serverInfo"]["name"], "Speedwave");
        assert!(result["protocolVersion"].is_string());
    }

    #[test]
    fn test_dispatch_initialize_has_tools_capability() {
        let params = serde_json::json!({"protocolVersion": "2024-11-05"});
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert!(
            result["capabilities"]["tools"].is_object(),
            "tools capability must be present so Claude calls tools/list"
        );
    }

    #[test]
    fn test_dispatch_initialize_echoes_client_protocol_version() {
        let params = serde_json::json!({"protocolVersion": "2025-06-18"});
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert_eq!(result["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn test_dispatch_notifications_initialized() {
        let resp = dispatch_method("notifications/initialized", None, serde_json::Value::Null);
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_dispatch_ide_connected() {
        let resp = dispatch_method("ide_connected", None, serde_json::Value::Null);
        assert!(resp.result.is_some());
    }

    #[test]
    fn test_dispatch_ping() {
        let resp = dispatch_method("ping", None, serde_json::json!(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_dispatch_unknown_method_returns_minus_32601() {
        let resp = dispatch_method("unknownMethod", None, serde_json::json!(1));
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[test]
    fn test_dispatch_tools_list_returns_all_12_tools() {
        let resp = dispatch_method("tools/list", None, serde_json::json!(1));
        let result = resp.result.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 12, "expected 12 IDE tools");
    }

    #[test]
    fn test_dispatch_tools_list_has_input_schemas() {
        let resp = dispatch_method("tools/list", None, serde_json::json!(1));
        let result = resp.result.unwrap();
        let tools = result["tools"].as_array().unwrap();
        for tool in tools {
            assert!(tool["name"].is_string(), "tool needs name");
            assert!(tool["inputSchema"].is_object(), "tool needs inputSchema");
        }
    }

    #[test]
    fn test_dispatch_tools_call_get_workspace_folders() {
        let params = serde_json::json!({
            "name": "getWorkspaceFolders",
            "arguments": {}
        });
        let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert!(result["content"].is_array());
        let content = &result["content"][0];
        assert_eq!(content["type"], "text");
        assert!(content["text"].as_str().unwrap().contains("/workspace"));
    }

    #[test]
    fn test_dispatch_tools_call_execute_code_returns_error() {
        let params = serde_json::json!({
            "name": "executeCode",
            "arguments": {"code": "print('hi')"}
        });
        let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn test_dispatch_tools_call_read_only_stubs_return_success() {
        for name in [
            "getCurrentSelection",
            "getLatestSelection",
            "getOpenEditors",
            "getWorkspaceFolders",
            "getDiagnostics",
            "checkDocumentDirty",
        ] {
            let params = serde_json::json!({"name": name, "arguments": {}});
            let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
            let result = resp.result.unwrap();
            assert_eq!(
                result["isError"], false,
                "read-only stub for {name} must return success"
            );
        }
    }

    #[test]
    fn test_dispatch_tools_call_action_stubs_return_error() {
        for name in [
            "openFile",
            "openDiff",
            "saveDocument",
            "close_tab",
            "closeAllDiffTabs",
        ] {
            let params = serde_json::json!({"name": name, "arguments": {}});
            let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
            let result = resp.result.unwrap();
            assert_eq!(
                result["isError"], true,
                "action stub for {name} must return error"
            );
        }
    }

    #[test]
    fn test_dispatch_tools_call_unknown_tool_returns_error() {
        let params = serde_json::json!({"name": "frobnicate", "arguments": {}});
        let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn test_handle_jsonrpc_valid_request_returns_response() {
        let json = r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#;
        let resp = handle_jsonrpc_message(json);
        assert!(resp.is_some());
        assert!(resp.unwrap().result.is_some());
    }

    #[test]
    fn test_handle_jsonrpc_notification_returns_none() {
        let json = r#"{"jsonrpc":"2.0","method":"selection_changed","params":{}}"#;
        let resp = handle_jsonrpc_message(json);
        assert!(
            resp.is_none(),
            "notification must return None (JSON-RPC 2.0)"
        );
    }

    #[test]
    fn test_handle_jsonrpc_parse_error_returns_32700() {
        let resp = handle_jsonrpc_message("not valid json {{{{").unwrap();
        assert_eq!(resp.error.unwrap().code, -32700);
        assert_eq!(resp.id, serde_json::Value::Null);
    }

    #[test]
    fn test_handle_jsonrpc_unknown_method_returns_32601() {
        let json = r#"{"jsonrpc":"2.0","method":"unknownXYZ","id":5}"#;
        let resp = handle_jsonrpc_message(json).unwrap();
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[test]
    fn test_ide_bridge_new_returns_valid_instance() {
        let bridge = IdeBridge::new().unwrap();
        assert!(bridge._tcp_port > 0, "TCP port should be assigned");
        // Path under the bridge subdir; the data dir prefix is determined
        // by SPEEDWAVE_DATA_DIR (may be overridden by other tests in this
        // binary), so we assert on the bridge-specific suffix only.
        assert!(
            bridge
                .lock_file_path
                .to_string_lossy()
                .contains("ide-bridge/"),
            "Lock file path should be in <data_dir>/ide-bridge/, got: {:?}",
            bridge.lock_file_path
        );
        assert!(
            bridge.lock_file_path.to_string_lossy().ends_with(".lock"),
            "Lock file path should end with .lock"
        );
    }

    #[test]
    fn test_write_lock_file_creates_correct_json() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_file_path = tmp.path().join("claude-ide").join("9999.lock");

        let bridge = IdeBridge::new_with_paths("test-auth-token-xyz", lock_file_path.clone(), 9999);

        bridge.write_lock_file().unwrap();

        assert!(lock_file_path.exists(), "Lock file should exist");

        let contents = std::fs::read_to_string(&lock_file_path).unwrap();
        let lock: IdeLockFile = serde_json::from_str(&contents).unwrap();
        assert_eq!(lock.auth_token, "test-auth-token-xyz");
        assert_eq!(lock.workspace_folders, vec!["/workspace"]);
        assert_eq!(lock.pid, 1);
        assert_eq!(lock.ide_name, "Speedwave");
        assert_eq!(lock.transport, "ws");
        assert_eq!(lock.running_in_windows, cfg!(windows));

        let raw: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert!(raw.get("wsUrl").is_none(), "wsUrl must not be in lock file");
        assert!(raw.get("port").is_none(), "port must not be in lock file");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_meta = std::fs::metadata(&lock_file_path).unwrap();
            let file_mode = file_meta.permissions().mode() & 0o777;
            assert_eq!(
                file_mode, 0o600,
                "Lock file should be 0o600, got {:o}",
                file_mode
            );

            let dir_meta = std::fs::metadata(lock_file_path.parent().unwrap()).unwrap();
            let dir_mode = dir_meta.permissions().mode() & 0o777;
            assert_eq!(
                dir_mode, 0o700,
                "Lock directory should be 0o700, got {:o}",
                dir_mode
            );
        }
    }

    #[test]
    fn test_stop_removes_lock_file() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_file_path = tmp.path().join("claude-ide").join("8888.lock");

        let mut bridge = IdeBridge::new_with_paths("token", lock_file_path.clone(), 8888);
        bridge.write_lock_file().unwrap();
        assert!(lock_file_path.exists());

        bridge.stop().unwrap();
        assert!(
            !lock_file_path.exists(),
            "Lock file should be removed after stop"
        );
    }

    #[test]
    fn test_stop_is_idempotent_when_files_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_file_path = tmp.path().join("nonexistent.lock");

        let mut bridge = IdeBridge::new_with_paths("token", lock_file_path, 7777);

        let result = bridge.stop();
        assert!(
            result.is_ok(),
            "stop() should succeed even when files are missing"
        );
    }

    #[test]
    fn test_lock_file_ide_name_transport_roundtrip() {
        let lock = IdeLockFile {
            pid: 1,
            workspace_folders: vec![],
            ide_name: "Speedwave".to_string(),
            transport: "ws".to_string(),
            running_in_windows: false,
            auth_token: "tok".to_string(),
        };
        let json = serde_json::to_string(&lock).unwrap();
        let back: IdeLockFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ide_name, "Speedwave");
        assert_eq!(back.transport, "ws");
        assert!(!back.running_in_windows);
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(super::constant_time_eq("token-a", "token-a"));
        assert!(!super::constant_time_eq("token-a", "token-b"));
        assert!(!super::constant_time_eq("short", "longer-string"));
        assert!(super::constant_time_eq("", ""));
    }

    // -----------------------------------------------------------------------
    // WebSocket integration tests — exercise the legacy `run_websocket_on_tcp`
    // entry point (HostBridge's accept loop is covered separately in
    // `bridges::host_bridge::tests`).
    // -----------------------------------------------------------------------

    async fn start_test_bridge(
        token: &str,
    ) -> (
        u16,
        tokio::sync::broadcast::Sender<()>,
        tokio::sync::broadcast::Sender<()>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::new(token.to_string())));
        let upstream = std::sync::Arc::new(std::sync::Mutex::new(None));
        let (tx, rx) = tokio::sync::broadcast::channel::<()>(1);
        let (upstream_changed_tx, _) = tokio::sync::broadcast::channel::<()>(4);
        tokio::spawn(super::run_websocket_on_tcp(
            listener,
            port,
            auth,
            upstream,
            upstream_changed_tx.clone(),
            None,
            rx,
        ));
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        (port, tx, upstream_changed_tx)
    }

    #[tokio::test]
    async fn test_websocket_valid_token_gets_response() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let token = "integration-test-token-xyz";
        let (port, tx, _upstream_changed_tx) = start_test_bridge(token).await;

        let url = format!("ws://127.0.0.1:{}/", port);
        let mut req = url.into_client_request().unwrap();
        req.headers_mut()
            .insert("x-claude-code-ide-authorization", token.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#.into(),
        ))
        .await
        .unwrap();

        let msg = ws.next().await.unwrap().unwrap();
        let resp: serde_json::Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert!(resp["result"]["tools"].is_array());

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_websocket_origin_header_rejected() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let token = "origin-test-token";
        let (port, tx, _upstream_changed_tx) = start_test_bridge(token).await;

        let url = format!("ws://127.0.0.1:{}/", port);
        let mut req = url.into_client_request().unwrap();
        req.headers_mut()
            .insert("x-claude-code-ide-authorization", token.parse().unwrap());
        req.headers_mut()
            .insert("origin", "http://evil.example.com".parse().unwrap());
        let result = tokio_tungstenite::connect_async(req).await;
        assert!(
            result.is_err(),
            "connection with Origin header must be rejected"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_websocket_invalid_token_rejected() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let (port, tx, _upstream_changed_tx) = start_test_bridge("correct-token").await;

        let url = format!("ws://127.0.0.1:{}/", port);
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert(
            "x-claude-code-ide-authorization",
            "WRONG-TOKEN".parse().unwrap(),
        );
        let result = tokio_tungstenite::connect_async(req).await;
        assert!(
            result.is_err(),
            "connection with wrong token must be rejected"
        );

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_websocket_notification_gets_no_response() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let token = "notif-test-token";
        let (port, tx, _upstream_changed_tx) = start_test_bridge(token).await;

        let url = format!("ws://127.0.0.1:{}/", port);
        let mut req = url.into_client_request().unwrap();
        req.headers_mut()
            .insert("x-claude-code-ide-authorization", token.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            r#"{"jsonrpc":"2.0","method":"selection_changed","params":{}}"#.into(),
        ))
        .await
        .unwrap();

        let timeout =
            tokio::time::timeout(tokio::time::Duration::from_millis(100), ws.next()).await;
        assert!(timeout.is_err(), "notification must not produce a response");

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn test_websocket_reconnects_on_upstream_change() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let token = "upstream-change-test-token";
        let (port, tx, upstream_changed_tx) = start_test_bridge(token).await;

        let url = format!("ws://127.0.0.1:{}/", port);
        let mut req = url.into_client_request().unwrap();
        req.headers_mut()
            .insert("x-claude-code-ide-authorization", token.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

        ws.send(Message::Text(
            r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#.into(),
        ))
        .await
        .unwrap();

        let msg = ws.next().await.unwrap().unwrap();
        let resp: serde_json::Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
        assert!(resp["result"]["tools"].is_array(), "tools/list should work");

        let _ = upstream_changed_tx.send(());

        let close_msg = tokio::time::timeout(tokio::time::Duration::from_secs(2), ws.next()).await;
        match close_msg {
            Ok(Some(Ok(Message::Close(_)))) => { /* expected */ }
            Ok(None) => { /* stream ended — also acceptable */ }
            Ok(Some(Err(_))) => { /* connection error — acceptable, means it was closed */ }
            Err(_) => panic!("timed out waiting for Close frame after upstream change"),
            other => panic!("unexpected message after upstream change: {:?}", other),
        }

        let _ = tx.send(());
    }

    #[test]
    fn test_clear_upstream_clears_value() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_file_path = tmp.path().join("bridge").join("12345.lock");

        let bridge = IdeBridge::new_with_paths("test-token", lock_file_path, 12345);

        {
            let mut guard = bridge.upstream.lock().unwrap();
            *guard = Some(super::UpstreamIde {
                ide_name: "Cursor".to_string(),
                port: 9999,
                auth_token: "upstream-token".to_string(),
            });
        }

        assert!(
            bridge.upstream_info().is_some(),
            "upstream should be Some before clear_upstream()"
        );

        bridge.clear_upstream();

        assert!(
            bridge.upstream_info().is_none(),
            "upstream_info() must return None after clear_upstream()"
        );
    }

    #[test]
    fn test_upstream_ide_debug_redacts_auth_token() {
        let secret = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        let upstream = super::UpstreamIde {
            ide_name: "Cursor".to_string(),
            port: 9999,
            auth_token: secret.to_string(),
        };
        let debug_output = format!("{:?}", upstream);
        assert!(
            debug_output.contains("***REDACTED***"),
            "Debug output must contain ***REDACTED*** but got: {debug_output}"
        );
        assert!(
            !debug_output.contains(secret),
            "Debug output must NOT contain the real auth token but got: {debug_output}"
        );
        assert!(
            debug_output.contains("Cursor"),
            "Debug output must still contain non-secret fields like ide_name"
        );
        assert!(
            debug_output.contains("9999"),
            "Debug output must still contain non-secret fields like port"
        );
    }
}
