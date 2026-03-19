use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use speedwave_runtime::consts;

// ---------------------------------------------------------------------------
// Lock file written to ~/.speedwave/ide-bridge/<port>.lock
// This directory is mounted directly into the container as /home/speedwave/.claude/ide/
// so Claude Code (inside container) discovers the Bridge without any file copying.
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
// Constant-time auth comparison
// ---------------------------------------------------------------------------

/// Constant-time string comparison to prevent timing attacks on auth tokens.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut result: u8 = 0;
    for (x, y) in a_bytes.iter().zip(b_bytes.iter()) {
        result |= x ^ y;
    }
    result == 0
}

// ---------------------------------------------------------------------------
// Auth state — per-session UUID token, constant-time comparison
// ---------------------------------------------------------------------------

// Token is a per-session UUID v4 generated at bridge startup. With 127.0.0.1
// binding + 122-bit random UUID (OS CSPRNG via getrandom), brute force is
// infeasible — no TTL or rate limiting needed.
pub(crate) struct AuthState {
    token: String,
}

impl AuthState {
    fn new(token: String) -> Self {
        Self { token }
    }

    fn validate(&self, provided_token: &str) -> bool {
        constant_time_eq(provided_token, &self.token)
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 protocol types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct JsonRpcRequest {
    /// Protocol version — required by JSON-RPC 2.0 spec but not read after deserialization.
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

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 response helpers
// ---------------------------------------------------------------------------

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
// JSON-RPC method dispatch — handles IDE commands from Claude
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP tools/list — returns the tool schemas Claude Code discovers via MCP
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
// MCP tools/call — dispatches tool invocations from Claude Code
// ---------------------------------------------------------------------------

/// MCP tools/call result: `content` array with a single text item.
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

#[allow(clippy::unwrap_used)] // serde_json::to_string on json!() literals is infallible
fn dispatch_tool_call(name: &str, _args: Option<&serde_json::Value>) -> serde_json::Value {
    use serde_json::json;
    match name {
        "openFile" => mcp_tool_error(
            "No IDE connected — file not opened. Connect an IDE in Speedwave Health Dashboard.",
        ),
        "openDiff" => mcp_tool_error("No IDE connected — diff not opened."),
        "getCurrentSelection" => {
            mcp_tool_result(&serde_json::to_string(&json!({"selection": null})).unwrap())
        }
        "getLatestSelection" => {
            mcp_tool_result(&serde_json::to_string(&json!({"selection": null})).unwrap())
        }
        "getOpenEditors" => {
            mcp_tool_result(&serde_json::to_string(&json!({"editors": []})).unwrap())
        }
        "getWorkspaceFolders" => {
            mcp_tool_result(&serde_json::to_string(&json!({"folders": ["/workspace"]})).unwrap())
        }
        "getDiagnostics" => {
            mcp_tool_result(&serde_json::to_string(&json!({"diagnostics": []})).unwrap())
        }
        "checkDocumentDirty" => {
            mcp_tool_result(&serde_json::to_string(&json!({"dirty": false})).unwrap())
        }
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
// JSON-RPC method dispatch — handles MCP protocol + IDE tools from Claude
// ---------------------------------------------------------------------------

pub(crate) fn dispatch_method(
    method: &str,
    params: Option<&serde_json::Value>,
    id: serde_json::Value,
) -> JsonRpcResponse {
    use serde_json::json;
    match method {
        // --- MCP protocol handshake ---
        // Claude Code sends `initialize` with protocolVersion, clientInfo, capabilities.
        // Server must respond with protocolVersion, serverInfo, capabilities.
        // capabilities.tools must be non-empty or Claude won't call tools/list.
        // Supported protocol versions: "2025-11-25", "2025-06-18", "2025-03-26",
        // "2024-11-05", "2024-10-07". We echo back the client's version.
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
                        "name": "Speedwave",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }
        // --- MCP tool discovery and invocation ---
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
        // --- MCP ping ---
        "ping" => jsonrpc_success(id, json!({})),
        // --- MCP notifications ---
        // These are filtered out as notifications in handle_jsonrpc_message
        // because they have no `id`, but if they arrive with an id, return success.
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

// ---------------------------------------------------------------------------
// JSON-RPC message handler — parses and dispatches incoming messages
// ---------------------------------------------------------------------------

pub(crate) fn handle_jsonrpc_message(
    text: &str,
    _auth: &Arc<Mutex<AuthState>>,
) -> Option<JsonRpcResponse> {
    let req: JsonRpcRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(_) => return Some(jsonrpc_parse_error()),
    };
    let id = req.id.clone().unwrap_or(serde_json::Value::Null);
    let is_notification = req.id.is_none();
    let resp = dispatch_method(&req.method, req.params.as_ref(), id);
    if is_notification {
        None // JSON-RPC 2.0: notifications get no response
    } else {
        Some(resp)
    }
}

// ---------------------------------------------------------------------------
// IDE Bridge — manages the connection between Claude (in VM) and IDE (on host)
//
// All platforms: Bridge listens on TCP 127.0.0.1:<random_port>.
// CLAUDE_CODE_IDE_HOST_OVERRIDE env var tells Claude the gateway DNS name.
//
// macOS:   Claude → ws://host.lima.internal:<port> → Lima gvproxy → host
// Linux:   Claude → ws://host.docker.internal:<port> → nerdctl → host
// Windows: Claude → ws://host.speedwave.internal:<port> → nerdctl → host
//
// Lock file at ~/.speedwave/ide-bridge/<port>.lock is mounted as
// /home/speedwave/.claude/ide/<port>.lock in the container (:ro).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stale lock file cleanup
// ---------------------------------------------------------------------------

/// Removes stale lock files in ~/.speedwave/ide-bridge/ whose TCP port is no
/// longer listening. Called at IDE Bridge startup to clean up leftovers from
/// crashed sessions.
fn cleanup_stale_lock_files() {
    let lock_dir = consts::data_dir().join("ide-bridge");
    let entries = match std::fs::read_dir(&lock_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("lock") {
            continue;
        }
        // Derive port from filename (e.g. "12345.lock" → 12345), same as Claude Code does.
        let Some(port) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u16>().ok())
        else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(200),
        )
        .is_err()
        {
            log::debug!(
                "removing stale lock file {:?} (port {} not listening)",
                path,
                port
            );
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The real IDE (Cursor / VS Code) that the Bridge should proxy connections to.
#[derive(Clone)]
pub struct UpstreamIde {
    /// IDE display name (e.g. "Cursor") — stored for config serialization and logging.
    pub ide_name: String,
    pub port: u16,
    /// authToken read from ~/.claude/ide/<port>.lock so we can authenticate to the real IDE.
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

// Windows ACL implementation lives in crate::fs_perms (shared with main.rs)

/// Write (or re-create) a lock file at `path` with the given auth state and port.
/// Standalone function so it can be called from both `IdeBridge::write_lock_file()`
/// and the watchdog thread.
fn write_lock_file_static(path: &PathBuf, auth: &Arc<Mutex<AuthState>>) -> anyhow::Result<()> {
    let lock_dir = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("invalid lock file path"))?;
    std::fs::create_dir_all(lock_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(lock_dir, std::fs::Permissions::from_mode(0o700))?;
    }

    let auth_guard = auth
        .lock()
        .map_err(|e| anyhow::anyhow!("auth mutex poisoned: {e}"))?;

    // Claude Code derives the port from the lock file **filename** (e.g. "12345.lock" → port 12345).
    // It constructs the WebSocket URL as ws://<host>:<port> — the host defaults to 127.0.0.1
    // but is overridden by CLAUDE_CODE_IDE_HOST_OVERRIDE env var in the container.
    // No wsUrl or port field is needed in the JSON — Claude ignores them.
    //
    // pid must be alive INSIDE the container for Claude Code to accept the lock file.
    // Claude Code runs `kill -0 <pid>` to check liveness — the host PID doesn't exist
    // in the container's PID namespace. PID 1 (container init) is always alive.
    let lock = IdeLockFile {
        pid: 1,
        workspace_folders: vec!["/workspace".to_string()],
        ide_name: "Speedwave".to_string(),
        transport: "ws".to_string(),
        running_in_windows: cfg!(windows),
        auth_token: auth_guard.token.clone(),
    };

    let content = serde_json::to_string_pretty(&lock)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        use std::io::Write;
        file.write_all(content.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, &content)?;
        #[cfg(windows)]
        let _ = crate::fs_perms::set_owner_only(path);
    }

    Ok(())
}

/// Callback invoked on IDE Bridge events (e.g. "connected", "stub_call").
/// Parameters: (event_kind, detail_message).
pub type EventCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct IdeBridge {
    auth: Arc<Mutex<AuthState>>,
    lock_file_path: PathBuf,
    tcp_port: u16,
    /// Held from new() until start() to eliminate the TOCTOU race where another
    /// process could grab the port between find_available_port() and re-bind.
    tcp_listener: Option<std::net::TcpListener>,
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_tx: tokio::sync::broadcast::Sender<()>,
    event_cb: Option<EventCallback>,
}

impl IdeBridge {
    pub fn new() -> anyhow::Result<Self> {
        let auth_token = uuid::Uuid::new_v4().to_string();
        // Bind immediately and hold the listener to eliminate the TOCTOU race
        // where another process could grab the port between bind and re-bind.
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let tcp_port = listener.local_addr()?.port();

        // Write to ~/.speedwave/ide-bridge/ — this dir is mounted directly into
        // the container as /home/speedwave/.claude/ide/ so Claude Code discovers us
        // without any file copying. No local Claude Code installation required.
        let lock_file_path = consts::data_dir()
            .join("ide-bridge")
            .join(format!("{}.lock", tcp_port));

        let (upstream_changed_tx, _) = tokio::sync::broadcast::channel(4);

        Ok(Self {
            auth: Arc::new(Mutex::new(AuthState::new(auth_token))),
            lock_file_path,
            tcp_port,
            tcp_listener: Some(listener),
            shutdown_tx: None,
            upstream: Arc::new(Mutex::new(None)),
            upstream_changed_tx,
            event_cb: None,
        })
    }

    /// Returns the upstream IDE name and port, if one is configured.
    pub fn upstream_info(&self) -> Option<(String, u16)> {
        self.upstream
            .lock()
            .ok()?
            .as_ref()
            .map(|u| (u.ide_name.clone(), u.port))
    }

    /// Returns the TCP port the Bridge is listening on.
    pub fn port(&self) -> u16 {
        self.tcp_port
    }

    /// Set an event callback for diagnostics and GUI integration.
    /// Must be called before `start()`.
    pub fn set_event_callback(&mut self, cb: EventCallback) {
        self.event_cb = Some(cb);
    }

    /// Set the upstream IDE to proxy connections to.
    /// Reads the auth token from ~/.claude/ide/<port>.lock.
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

        // Signal active WebSocket connections to close so Claude reconnects
        // and picks up the new upstream.
        let _ = self.upstream_changed_tx.send(());

        Ok(())
    }

    /// Clear the upstream IDE so the Bridge falls back to stub mode.
    /// Signals active WebSocket proxy connections to disconnect.
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

    /// Test-only constructor: inject custom paths and auth token for isolated testing.
    #[cfg(test)]
    fn new_with_paths(auth_token: &str, lock_file_path: PathBuf, tcp_port: u16) -> Self {
        let (upstream_changed_tx, _) = tokio::sync::broadcast::channel(4);
        Self {
            auth: Arc::new(Mutex::new(AuthState::new(auth_token.to_string()))),
            lock_file_path,
            tcp_port,
            tcp_listener: None,
            shutdown_tx: None,
            upstream: Arc::new(Mutex::new(None)),
            upstream_changed_tx,
            event_cb: None,
        }
    }

    /// Start the IDE Bridge: bind TCP port, write lock file.
    ///
    /// Called from Tauri's synchronous `.setup()` — no Tokio runtime is active yet
    /// at that point, so we spin up a dedicated background thread with its own
    /// single-threaded Tokio runtime instead of using `tokio::spawn`.
    ///
    /// The Bridge listens on `127.0.0.1:<port>`. Containers reach it via
    /// host gateway DNS names (host.lima.internal, host.docker.internal,
    /// host.speedwave.internal) which route to loopback on the host.
    pub fn start(&mut self) -> anyhow::Result<()> {
        cleanup_stale_lock_files();
        let (tx, _rx) = tokio::sync::broadcast::channel::<()>(1);
        self.shutdown_tx = Some(tx.clone());

        let listener = self.tcp_listener.take().ok_or_else(|| {
            anyhow::anyhow!("TCP listener already consumed (start called twice?)")
        })?;
        let port = self.tcp_port;
        let auth = self.auth.clone();
        let upstream = self.upstream.clone();
        let upstream_changed_tx = self.upstream_changed_tx.clone();
        let event_cb = self.event_cb.clone();
        let rx = tx.subscribe();
        std::thread::spawn(move || match tokio::runtime::Runtime::new() {
            Ok(rt) => rt.block_on(run_websocket_on_tcp(
                listener,
                port,
                auth,
                upstream,
                upstream_changed_tx,
                event_cb,
                rx,
            )),
            Err(e) => log::error!("failed to create tokio runtime: {e}"),
        });

        self.write_lock_file()?;

        // Watchdog: re-create lock file if it disappears (e.g. container restart,
        // volume cleanup, or accidental deletion). Checks every 5 seconds.
        let lock_path = self.lock_file_path.clone();
        let auth_for_watchdog = self.auth.clone();
        let mut shutdown_rx = tx.subscribe();
        std::thread::spawn(move || loop {
            match shutdown_rx.try_recv() {
                Ok(_) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                _ => {}
            }
            std::thread::sleep(Duration::from_secs(5));
            // Re-check shutdown after sleeping — prevents re-creating the lock file
            // after stop() has already deleted it and sent the shutdown signal.
            match shutdown_rx.try_recv() {
                Ok(_) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                _ => {}
            }
            if !lock_path.exists() {
                log::warn!("lock file missing, recreating {:?}", lock_path);
                if let Err(e) = write_lock_file_static(&lock_path, &auth_for_watchdog) {
                    log::error!("failed to recreate lock file: {e}");
                }
            }
        });

        Ok(())
    }

    fn write_lock_file(&self) -> anyhow::Result<()> {
        write_lock_file_static(&self.lock_file_path, &self.auth)
    }

    /// Stop and clean up — send shutdown signal, remove lock file.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        // Synchronous broadcast — Sender::send() does not require async/await
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if self.lock_file_path.exists() {
            std::fs::remove_file(&self.lock_file_path)?;
        }
        Ok(())
    }
}

impl Drop for IdeBridge {
    fn drop(&mut self) {
        // Best-effort cleanup — ignore errors during drop
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
// WebSocket connection handler — stub mode (no upstream IDE configured)
// ---------------------------------------------------------------------------

#[allow(clippy::result_large_err)]
async fn handle_websocket_connection<S>(
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
            // Reject connections with an Origin header. Browsers set Origin on
            // WebSocket upgrades; Claude Code (CLI) and IDE extensions don't.
            // This prevents CSRF-style attacks from malicious web pages.
            if req.headers().get("origin").is_some() {
                return Err(http::Response::builder()
                    .status(http::StatusCode::FORBIDDEN)
                    .body(Some("Origin header not allowed".to_string()))
                    .unwrap_or_else(|_| http::Response::new(Some("Forbidden".to_string()))));
            }

            let token = req
                .headers()
                .get("x-claude-code-ide-authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let authorized = auth_clone
                .lock()
                .map(|a| a.validate(token))
                .unwrap_or(false);
            if authorized {
                // Echo the "mcp" subprotocol back — Claude Code connects with
                // `protocols: ["mcp"]` and expects the server to confirm it.
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

    // Check if upstream IDE is configured — if so, proxy; otherwise use stubs.
    let upstream_opt = upstream.lock().ok().and_then(|g| g.clone());
    if let Some(up) = upstream_opt {
        proxy_to_upstream(ws, up, upstream_changed_rx, event_cb.clone()).await;
    } else {
        handle_with_stubs(ws, auth, upstream_changed_rx, event_cb.clone()).await;
    }

    emit_event(&event_cb, "disconnected", "Claude WebSocket closed");
}

/// Transparent bidirectional proxy: forwards every message between Claude and the real IDE.
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
        .insert("x-claude-code-ide-authorization", auth_header_value);
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

    // Use an mpsc channel to funnel all IDE writes through a single task.
    // This allows both claude_to_ide and heartbeat to send to the IDE
    // without ownership conflicts on ide_write.
    let (ide_tx, mut ide_rx) = tokio::sync::mpsc::channel::<Message>(32);

    // Forward Claude → IDE via the channel.
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

    // Heartbeat: send Ping every 15s to detect dead upstream IDE.
    // Note: upstream_lost is emitted by ide_writer when the channel closes;
    // heartbeat only needs to break so the select! can detect the dead connection.
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

    // Sole writer to the IDE WebSocket — drains the mpsc channel.
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

    // Forward IDE → Claude.
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
    // Dropping all halves closes the underlying TCP connections.
    // Claude Code handles this as a disconnect and reconnects.
}

/// Stub handler used when no upstream IDE is selected.
async fn handle_with_stubs<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    auth: Arc<Mutex<AuthState>>,
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
                        // Emit stub_call for tools/call requests
                        if let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) {
                            if req.get("method").and_then(|m| m.as_str()) == Some("tools/call") {
                                let tool_name = req.get("params")
                                    .and_then(|p| p.get("name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("unknown");
                                emit_event(&event_cb, "stub_call", &format!("{} (no IDE connected)", tool_name));
                            }
                        }
                        if let Some(resp) = handle_jsonrpc_message(&text, &auth) {
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
// WebSocket TCP listener — all platforms
// ---------------------------------------------------------------------------
//
// The Bridge listens on 127.0.0.1. Containers reach the host via DNS names
// that route to loopback:
//   macOS   → host.lima.internal
//   Linux   → host.docker.internal
//   Windows → host.speedwave.internal

async fn run_websocket_on_tcp(
    std_listener: std::net::TcpListener,
    port: u16,
    auth: Arc<Mutex<AuthState>>,
    upstream: Arc<Mutex<Option<UpstreamIde>>>,
    upstream_changed_tx: tokio::sync::broadcast::Sender<()>,
    event_cb: Option<EventCallback>,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) {
    // Convert std listener to tokio — requires non-blocking mode.
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
    log::info!("listening on TCP 127.0.0.1:{port}");
    loop {
        tokio::select! {
            accept = listener.accept() => {
                match accept {
                    Ok((stream, addr)) => {
                        log::debug!("incoming connection from {addr}");
                        let auth = auth.clone();
                        let upstream = upstream.clone();
                        let upstream_changed_rx = upstream_changed_tx.subscribe();
                        let event_cb = event_cb.clone();
                        tokio::spawn(handle_websocket_connection(stream, auth, upstream, upstream_changed_rx, event_cb));
                    }
                    Err(e) => log::error!("TCP accept error: {e}"),
                }
            }
            _ = shutdown_rx.recv() => {
                log::info!("shutting down TCP listener");
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Utility — find an available TCP port (test-only; production uses IdeBridge::new())
// ---------------------------------------------------------------------------

#[cfg(test)]
fn find_available_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
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
        // With 127.0.0.1 + UUID token, no rate limiting — valid token always works
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
        // Claude Code ignores wsUrl/port — they must NOT be in the lock file
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
        let json = r#"{"jsonrpc":"2.0","method":"selection_changed","params":{}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert!(req.id.is_none(), "notification must have no id");
    }

    #[test]
    fn test_jsonrpc_request_string_id() {
        let json = r#"{"jsonrpc":"2.0","method":"getWorkspaceFolders","id":"abc-123"}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, Some(serde_json::json!("abc-123")));
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
        assert!(json.contains("-32601"));
        assert!(!json.contains("\"result\""));
    }

    #[test]
    fn test_jsonrpc_parse_error_has_null_id() {
        let resp = jsonrpc_parse_error();
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"id\":null"));
        assert!(json.contains("-32700"));
    }

    #[test]
    fn test_dispatch_initialize_returns_mcp_response() {
        let params = serde_json::json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "claude-code", "version": "2.1.49"}
        });
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(0));
        let result = resp.result.unwrap();
        assert_eq!(result["protocolVersion"], "2025-11-25");
        assert!(result.get("capabilities").is_some());
        assert_eq!(result["serverInfo"]["name"], "Speedwave");
    }

    #[test]
    fn test_dispatch_initialize_has_tools_capability() {
        let params = serde_json::json!({"protocolVersion": "2025-11-25"});
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(0));
        let result = resp.result.unwrap();
        // capabilities.tools must be non-empty or Claude won't call tools/list
        assert_eq!(result["capabilities"]["tools"]["listChanged"], true);
    }

    #[test]
    fn test_dispatch_initialize_echoes_client_protocol_version() {
        let params = serde_json::json!({"protocolVersion": "2024-11-05"});
        let resp = dispatch_method("initialize", Some(&params), serde_json::json!(0));
        let result = resp.result.unwrap();
        assert_eq!(result["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn test_dispatch_notifications_initialized() {
        let resp = dispatch_method("notifications/initialized", None, serde_json::json!(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_dispatch_ide_connected() {
        let params = serde_json::json!({"pid": 12345});
        let resp = dispatch_method("ide_connected", Some(&params), serde_json::json!(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_dispatch_ping() {
        let resp = dispatch_method("ping", None, serde_json::json!(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_dispatch_unknown_method_returns_minus_32601() {
        let resp = dispatch_method("nonExistentMethod", None, serde_json::json!(42));
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32601);
    }

    #[test]
    fn test_dispatch_tools_list_returns_all_12_tools() {
        let resp = dispatch_method("tools/list", None, serde_json::json!(1));
        let result = resp.result.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 12, "should have 12 MCP tools");
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"openFile"));
        assert!(names.contains(&"getDiagnostics"));
        assert!(names.contains(&"getWorkspaceFolders"));
        assert!(names.contains(&"executeCode"));
        assert!(names.contains(&"close_tab"));
    }

    #[test]
    fn test_dispatch_tools_list_has_input_schemas() {
        let resp = dispatch_method("tools/list", None, serde_json::json!(1));
        let tools = resp.result.unwrap()["tools"].as_array().unwrap().clone();
        for tool in &tools {
            assert!(
                tool.get("inputSchema").is_some(),
                "tool {} must have inputSchema",
                tool["name"]
            );
            assert!(
                tool.get("description").is_some(),
                "tool {} must have description",
                tool["name"]
            );
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
        // MCP tools/call returns { content: [{type:"text", text:"..."}], isError: false }
        assert_eq!(result["isError"], false);
        let text = result["content"][0]["text"].as_str().unwrap();
        let inner: serde_json::Value = serde_json::from_str(text).unwrap();
        assert!(inner["folders"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("/workspace")));
    }

    #[test]
    fn test_dispatch_tools_call_execute_code_returns_error() {
        let params = serde_json::json!({
            "name": "executeCode",
            "arguments": {"code": "print('hello')"}
        });
        let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn test_dispatch_tools_call_read_only_stubs_return_success() {
        let read_only_tools = [
            "getCurrentSelection",
            "getLatestSelection",
            "getOpenEditors",
            "getWorkspaceFolders",
            "getDiagnostics",
            "checkDocumentDirty",
        ];
        for name in read_only_tools {
            let params = serde_json::json!({"name": name, "arguments": {}});
            let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
            let result = resp.result.unwrap();
            assert_eq!(
                result["isError"], false,
                "read-only tool {} should not return error",
                name
            );
            assert!(
                result["content"][0]["type"].as_str() == Some("text"),
                "tool {} should return text content",
                name
            );
        }
    }

    #[test]
    fn test_dispatch_tools_call_action_stubs_return_error() {
        let action_tools = [
            "openFile",
            "openDiff",
            "saveDocument",
            "close_tab",
            "closeAllDiffTabs",
        ];
        for name in action_tools {
            let params = serde_json::json!({"name": name, "arguments": {}});
            let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
            let result = resp.result.unwrap();
            assert_eq!(
                result["isError"], true,
                "action tool {} should return isError: true when no IDE connected",
                name
            );
            let text = result["content"][0]["text"].as_str().unwrap();
            assert!(
                text.contains("No IDE connected"),
                "action tool {} error message should mention 'No IDE connected', got: {}",
                name,
                text
            );
        }
    }

    #[test]
    fn test_dispatch_tools_call_unknown_tool_returns_error() {
        let params = serde_json::json!({"name": "nonExistentTool", "arguments": {}});
        let resp = dispatch_method("tools/call", Some(&params), serde_json::json!(1));
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn test_handle_jsonrpc_valid_request_returns_response() {
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::new("tok".to_string())));
        let json = r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#;
        let resp = handle_jsonrpc_message(json, &auth);
        assert!(resp.is_some());
        assert!(resp.unwrap().result.is_some());
    }

    #[test]
    fn test_handle_jsonrpc_notification_returns_none() {
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::new("tok".to_string())));
        let json = r#"{"jsonrpc":"2.0","method":"selection_changed","params":{}}"#;
        let resp = handle_jsonrpc_message(json, &auth);
        assert!(
            resp.is_none(),
            "notification must return None (JSON-RPC 2.0)"
        );
    }

    #[test]
    fn test_handle_jsonrpc_parse_error_returns_32700() {
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::new("tok".to_string())));
        let resp = handle_jsonrpc_message("not valid json {{{{", &auth).unwrap();
        assert_eq!(resp.error.unwrap().code, -32700);
        assert_eq!(resp.id, serde_json::Value::Null);
    }

    #[test]
    fn test_handle_jsonrpc_unknown_method_returns_32601() {
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::new("tok".to_string())));
        let json = r#"{"jsonrpc":"2.0","method":"unknownXYZ","id":5}"#;
        let resp = handle_jsonrpc_message(json, &auth).unwrap();
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[test]
    fn test_ide_bridge_new_returns_valid_instance() {
        let bridge = IdeBridge::new().unwrap();
        assert!(bridge.tcp_port > 0, "TCP port should be assigned");
        assert!(
            bridge
                .lock_file_path
                .to_string_lossy()
                .contains(".speedwave/ide-bridge/"),
            "Lock file path should be in .speedwave/ide-bridge/, got: {:?}",
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
        // pid=1 so Claude Code (in container) sees it as alive via kill -0
        assert_eq!(lock.pid, 1);
        assert_eq!(lock.ide_name, "Speedwave");
        assert_eq!(lock.transport, "ws");
        assert_eq!(lock.running_in_windows, cfg!(windows));

        // Claude Code derives port from filename, not from JSON fields.
        // Verify no wsUrl/port fields leaked into the JSON.
        let raw: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert!(raw.get("wsUrl").is_none(), "wsUrl must not be in lock file");
        assert!(raw.get("port").is_none(), "port must not be in lock file");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Lock file should be 0o600
            let file_meta = std::fs::metadata(&lock_file_path).unwrap();
            let file_mode = file_meta.permissions().mode() & 0o777;
            assert_eq!(
                file_mode, 0o600,
                "Lock file should be 0o600, got {:o}",
                file_mode
            );

            // Lock directory should be 0o700
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

        // stop() should not error when files don't exist
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
    // WebSocket integration tests — use TCP loopback (works on all platforms)
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

        // Connect and verify tools/list works (stub mode).
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

        // Simulate upstream IDE switch — send on upstream_changed_tx.
        let _ = upstream_changed_tx.send(());

        // The existing connection should receive a Close frame.
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

    // ── clear_upstream tests ──────────────────────────────────────────────────

    #[test]
    fn test_clear_upstream_clears_value() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_file_path = tmp.path().join("bridge").join("12345.lock");

        let bridge = IdeBridge::new_with_paths("test-token", lock_file_path, 12345);

        // Manually inject an upstream by writing directly to the shared Arc<Mutex<...>>.
        {
            let mut guard = bridge.upstream.lock().unwrap();
            *guard = Some(super::UpstreamIde {
                ide_name: "Cursor".to_string(),
                port: 9999,
                auth_token: "upstream-token".to_string(),
            });
        }

        // Verify the upstream is set before clearing.
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

    // ── UpstreamIde Debug redaction tests ────────────────────────────────────

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
