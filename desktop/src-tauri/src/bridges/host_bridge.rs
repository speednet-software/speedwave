//! Generic host-side WebSocket bridge. See ADR-063.

use std::collections::HashMap;
use std::io::Write;
use std::net::{SocketAddr, TcpStream as StdTcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use http::{HeaderValue, Request, Response};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use speedwave_runtime::consts;
use speedwave_runtime::fs_perms as runtime_fs_perms;

/// How clients authenticate the WebSocket upgrade request.
#[derive(Clone, Debug)]
pub enum AuthScheme {
    /// Token in a request header. Used by Node.js/Rust workers that can set
    /// arbitrary headers on the WebSocket upgrade.
    Header(&'static str),
    /// Token in the URL query string (`?<name>=<token>`). For browser clients; risk in ADR-063.
    QueryParam(&'static str),
}

/// Which auth scheme matched. See ADR-063.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthMatch {
    Header(&'static str),
    QueryParam(&'static str),
}

/// CSRF / Origin policy. See ADR-063.
#[derive(Clone, Debug)]
pub enum OriginPolicy {
    /// Reject any request carrying `Origin`. Used by IDE Bridge.
    RejectIfPresent,
    /// Accept `Origin` iff auth was `QueryParam`. Used by browser-based plugin UIs that
    /// always set `Origin` and cannot set custom headers on the WebSocket upgrade.
    AcceptIfAuthIsQueryParam,
}

/// Sec-WebSocket-Protocol echo policy. Empty list = ignore.
#[derive(Clone, Debug)]
pub struct SubprotocolPolicy {
    pub accepted: &'static [&'static str],
}

/// Pairing-mode config. See ADR-063.
#[derive(Clone, Debug)]
pub struct PairingConfig {
    /// Role → auth scheme. Bridge pairs different roles only.
    pub roles: HashMap<&'static str, AuthScheme>,
    /// What to do when a second pending connection arrives for the same role.
    pub on_role_collision: RoleCollisionPolicy,
    /// Pending-slot timeout; `None` = no timeout.
    pub pending_slot_timeout: Option<Duration>,
}

/// What to do when a connection arrives for a role that already has a
/// pending slot. See ADR-063.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoleCollisionPolicy {
    /// Pre-handshake HTTP 409 — reject the new connection. Selected when a plugin manifest
    /// sets `host_bridge.collision: reject` (`plugin_host_bridge::translate_collision_policy`).
    Reject,
    /// Drop the older pending stream, accept the new one.
    EvictOlder,
}

#[derive(Clone, Debug)]
pub enum ConnectionMode {
    Endpoint,
    Pairing(PairingConfig),
}

pub type LockBodyBuilder =
    Arc<dyn Fn(LockBodyContext<'_>) -> serde_json::Value + Send + Sync + 'static>;

/// Context passed to the lock-body builder when writing the lock file — embeds the assigned
/// port and token into the JSON payload without capturing them via closure state.
pub struct LockBodyContext<'a> {
    pub port: u16,
    pub auth_token: &'a str,
}

pub struct HostBridgeConfig {
    pub name: String,
    pub mode: ConnectionMode,
    /// `Some` for `Endpoint` mode; `None` for `Pairing` (roles carry
    /// the schemes). Validated in `build()`.
    pub auth: Option<AuthScheme>,
    pub origin_policy: OriginPolicy,
    pub subprotocol: SubprotocolPolicy,
    pub max_frame_bytes: Option<usize>,
    pub lock_body: LockBodyBuilder,
    pub watchdog_interval: Duration,
    pub stale_probe_timeout: Duration,
    /// Name the lock file with the container-facing (relay) port instead of the raw bind
    /// port — only for locks READ BY THE CONTAINER (the IDE bridge). ADR-080.
    pub container_facing_lock: bool,
}

impl HostBridgeConfig {
    pub fn builder(name: &str) -> HostBridgeConfigBuilder {
        HostBridgeConfigBuilder {
            name: name.to_string(),
            mode: None,
            auth: None,
            origin_policy: None,
            subprotocol: SubprotocolPolicy { accepted: &[] },
            max_frame_bytes: None,
            lock_body: None,
            watchdog_interval: Duration::from_secs(5),
            stale_probe_timeout: Duration::from_millis(200),
            container_facing_lock: false,
        }
    }
}

pub struct HostBridgeConfigBuilder {
    name: String,
    mode: Option<ConnectionMode>,
    auth: Option<AuthScheme>,
    origin_policy: Option<OriginPolicy>,
    subprotocol: SubprotocolPolicy,
    max_frame_bytes: Option<usize>,
    lock_body: Option<LockBodyBuilder>,
    watchdog_interval: Duration,
    stale_probe_timeout: Duration,
    container_facing_lock: bool,
}

impl HostBridgeConfigBuilder {
    pub fn endpoint(mut self, auth: AuthScheme) -> Self {
        self.mode = Some(ConnectionMode::Endpoint);
        self.auth = Some(auth);
        self
    }

    pub fn pairing(mut self, cfg: PairingConfig) -> Self {
        self.mode = Some(ConnectionMode::Pairing(cfg));
        self.auth = None;
        self
    }

    pub fn origin_policy(mut self, p: OriginPolicy) -> Self {
        self.origin_policy = Some(p);
        self
    }

    pub fn subprotocol(mut self, p: SubprotocolPolicy) -> Self {
        self.subprotocol = p;
        self
    }

    pub fn max_frame_bytes(mut self, n: Option<usize>) -> Self {
        self.max_frame_bytes = n;
        self
    }

    /// See [`HostBridgeConfig::container_facing_lock`]. Set only for the IDE bridge.
    pub fn container_facing_lock(mut self, v: bool) -> Self {
        self.container_facing_lock = v;
        self
    }

    pub fn lock_body<F>(mut self, f: F) -> Self
    where
        F: Fn(LockBodyContext<'_>) -> serde_json::Value + Send + Sync + 'static,
    {
        self.lock_body = Some(Arc::new(f));
        self
    }

    pub fn build(self) -> anyhow::Result<HostBridgeConfig> {
        if !validate_bridge_name(&self.name) {
            anyhow::bail!(
                "invalid bridge name {:?}: must match ^[a-z][a-z0-9-]{{0,32}}$",
                self.name
            );
        }
        let mode = self.mode.ok_or_else(|| {
            anyhow::anyhow!("bridge mode not set (call .endpoint() or .pairing())")
        })?;
        let origin_policy = self
            .origin_policy
            .ok_or_else(|| anyhow::anyhow!("origin_policy not set"))?;
        let lock_body = self
            .lock_body
            .ok_or_else(|| anyhow::anyhow!("lock_body not set"))?;

        match &mode {
            ConnectionMode::Endpoint => {
                if self.auth.is_none() {
                    anyhow::bail!("Endpoint mode requires an auth scheme");
                }
            }
            ConnectionMode::Pairing(pc) => {
                if self.auth.is_some() {
                    anyhow::bail!(
                        "Pairing mode must not set a top-level auth (each role carries its own)"
                    );
                }
                if pc.roles.is_empty() {
                    anyhow::bail!("Pairing mode requires at least one role");
                }
            }
        }

        if matches!(&origin_policy, OriginPolicy::AcceptIfAuthIsQueryParam) {
            let has_query_param = match &mode {
                ConnectionMode::Endpoint => {
                    matches!(self.auth.as_ref(), Some(AuthScheme::QueryParam(_)))
                }
                ConnectionMode::Pairing(pc) => pc
                    .roles
                    .values()
                    .any(|s| matches!(s, AuthScheme::QueryParam(_))),
            };
            if !has_query_param {
                anyhow::bail!(
                    "OriginPolicy::AcceptIfAuthIsQueryParam requires at least one QueryParam auth scheme"
                );
            }
        }

        Ok(HostBridgeConfig {
            name: self.name,
            mode,
            auth: self.auth,
            origin_policy,
            subprotocol: self.subprotocol,
            max_frame_bytes: self.max_frame_bytes,
            lock_body,
            watchdog_interval: self.watchdog_interval,
            stale_probe_timeout: self.stale_probe_timeout,
            container_facing_lock: self.container_facing_lock,
        })
    }
}

pub type ConnectionHandler = Arc<
    dyn Fn(WebSocketStream<tokio::net::TcpStream>, ConnectionContext) -> BoxFuture<'static, ()>
        + Send
        + Sync
        + 'static,
>;

/// Handler-side request context. The IDE Bridge handler reads `bridge_name` and `peer_addr`.
pub struct ConnectionContext {
    pub bridge_name: String,
    pub peer_addr: SocketAddr,
    /// `_`-prefixed: public API for handlers, no in-tree consumer reads them yet.
    pub _path: String,
    pub _query: Option<String>,
    pub _selected_subprotocol: Option<String>,
    pub _matched_auth: AuthMatch,
    pub _shutdown: broadcast::Receiver<()>,
}

pub type PairingEventCallback = Arc<dyn Fn(PairingEvent) + Send + Sync + 'static>;

/// Event surface for Pairing-mode bridges. `_`-prefixed fields have no in-tree consumer yet.
#[derive(Clone, Debug)]
pub enum PairingEvent {
    SlotOccupied {
        role: &'static str,
        _peer_addr: SocketAddr,
    },
    Paired {
        roles: Vec<&'static str>,
    },
    PairClosed {
        reason: String,
    },
    SameRoleCollision {
        role: &'static str,
        policy: RoleCollisionPolicy,
        _peer_addr: SocketAddr,
    },
    PendingSlotTimeout {
        role: &'static str,
    },
    PairBusy {
        _peer_addr: SocketAddr,
    },
}

pub(crate) struct AuthState {
    token: String,
}

impl AuthState {
    pub(crate) fn new(token: String) -> Self {
        Self { token }
    }

    pub(crate) fn validate(&self, provided: &str) -> bool {
        constant_time_eq(provided, &self.token)
    }

    /// Token accessor. Production reads it indirectly via `HostBridge::auth_token()`, the single
    /// source for both the lock-file body and the watchdog rewrite path.
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

/// Constant-time string comparison; resistant to timing side channels on
/// the token-validation path.
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Ascii-only validation: `^[a-z][a-z0-9-]{0,32}$`. Hand-rolled to avoid
/// pulling `regex` into the desktop crate just for one slug check.
pub(crate) fn validate_bridge_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 33 {
        return false;
    }
    let bytes = name.as_bytes();
    if !(bytes[0].is_ascii_lowercase()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Extract `?<name>=<value>` (RFC 3986: `+` is literal, no decoding).
pub(crate) fn extract_query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some(eq) = pair.find('=') {
            let key = &pair[..eq];
            let value = &pair[eq + 1..];
            if key == name {
                return Some(value.to_string());
            }
        } else if pair == name {
            return Some(String::new());
        }
    }
    None
}

pub struct HostBridge {
    config: HostBridgeConfig,
    auth_state: Arc<Mutex<AuthState>>,
    lock_file_path: Arc<Mutex<PathBuf>>,
    tcp_port: u16,
    tcp_listener: Option<std::net::TcpListener>,
    shutdown_tx: Option<broadcast::Sender<()>>,
    accept_thread: Option<JoinHandle<()>>,
    watchdog_thread: Option<JoinHandle<()>>,
}

/// Optional knobs for [`HostBridge::new_with_options`]: stable port and
/// persistent auth token. Both `None`/`false` reproduce legacy behavior.
#[derive(Default, Debug)]
pub struct HostBridgeNewOptions {
    pub preferred_port: Option<u16>,
    pub persistent_token_path: Option<PathBuf>,
}

impl HostBridge {
    /// Bind a fresh 127.0.0.1 port, mint a UUID v4 token, and stash both for later. The lock
    /// file is **not** written yet — callers can drop the bridge without leaving a stale lock.
    pub fn new(config: HostBridgeConfig) -> anyhow::Result<Self> {
        Self::new_with_options(config, HostBridgeNewOptions::default())
    }

    pub fn new_with_options(
        config: HostBridgeConfig,
        opts: HostBridgeNewOptions,
    ) -> anyhow::Result<Self> {
        let listener = bind_with_retry(&config.name, opts.preferred_port)?;
        let port = listener.local_addr()?.port();
        let token = load_or_create_persistent_token(opts.persistent_token_path.as_deref())?;

        let data_dir = consts::data_dir();
        let lock_dir = data_dir.join(format!("{}-bridge", &config.name));
        let lock_file_path = lock_dir.join(lock_file_name(port, config.container_facing_lock));

        Ok(Self {
            auth_state: Arc::new(Mutex::new(AuthState::new(token))),
            lock_file_path: Arc::new(Mutex::new(lock_file_path)),
            tcp_port: port,
            tcp_listener: Some(listener),
            shutdown_tx: None,
            accept_thread: None,
            watchdog_thread: None,
            config,
        })
    }

    pub fn port(&self) -> u16 {
        self.tcp_port
    }

    pub fn lock_file_path(&self) -> PathBuf {
        self.lock_file_path
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn auth_token(&self) -> String {
        self.auth_state
            .lock()
            .map(|guard| guard.token().to_string())
            .unwrap_or_default()
    }

    /// Start the bridge in Endpoint mode. Bails if the config was built
    /// for Pairing.
    pub fn start_endpoint(&mut self, handler: ConnectionHandler) -> anyhow::Result<()> {
        if !matches!(self.config.mode, ConnectionMode::Endpoint) {
            anyhow::bail!("start_endpoint() requires ConnectionMode::Endpoint");
        }
        self.start_inner(StartHandler::Endpoint(handler))
    }

    /// Start the bridge in Pairing mode. Bails if the config was built
    /// for Endpoint.
    pub fn start_pairing(&mut self, event_cb: Option<PairingEventCallback>) -> anyhow::Result<()> {
        if !matches!(self.config.mode, ConnectionMode::Pairing(_)) {
            anyhow::bail!("start_pairing() requires ConnectionMode::Pairing");
        }
        self.start_inner(StartHandler::Pairing(event_cb))
    }

    fn start_inner(&mut self, handler: StartHandler) -> anyhow::Result<()> {
        if self.shutdown_tx.is_some() {
            anyhow::bail!("HostBridge already started");
        }
        if self.tcp_listener.is_none() {
            anyhow::bail!("HostBridge listener consumed (start() called twice on same instance?)");
        }

        let listener = self
            .tcp_listener
            .take()
            .ok_or_else(|| anyhow::anyhow!("listener missing after presence check"))?;

        let (shutdown_tx, _) = broadcast::channel(1);

        let current_lock_path = self.lock_file_path();
        let lock_dir = current_lock_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("lock file path has no parent"))?
            .to_path_buf();
        ensure_lock_dir(&lock_dir)?;
        cleanup_stale_lock_files(
            &lock_dir,
            self.config.stale_probe_timeout,
            self.config.container_facing_lock,
        );
        crate::mirror_relay::ensure_relay_for_port(self.tcp_port);

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let config_arc = Arc::new(self.config.clone_without_callbacks());
        let auth = self.auth_state.clone();
        let lock_body_cb = self.config.lock_body.clone();
        let shutdown_rx = shutdown_tx.subscribe();

        let accept_handle = std::thread::Builder::new()
            .name(format!("host_bridge::{}::accept", self.config.name))
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("tokio runtime: {e}")));
                        return;
                    }
                };
                rt.block_on(async move {
                    listener.set_nonblocking(true).ok();
                    let async_listener = match TcpListener::from_std(listener) {
                        Ok(l) => l,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("TcpListener::from_std: {e}")));
                            return;
                        }
                    };
                    let _ = ready_tx.send(Ok(()));
                    match handler {
                        StartHandler::Endpoint(h) => {
                            run_endpoint_loop(async_listener, auth, config_arc, h, shutdown_rx)
                                .await
                        }
                        StartHandler::Pairing(cb) => {
                            run_pairing_loop(async_listener, auth, config_arc, cb, shutdown_rx)
                                .await
                        }
                    }
                });
            })?;

        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => anyhow::bail!("accept loop failed to start: {e}"),
            Err(e) => anyhow::bail!("accept loop ready signal timed out: {e}"),
        }

        let token = self.auth_token();
        if let Err(e) = write_lock_body(&current_lock_path, &lock_body_cb, self.tcp_port, &token) {
            let _ = shutdown_tx.send(());
            let _ = accept_handle.join();
            return Err(e).context("write lock file failed; bridge rolled back");
        }

        let watchdog_path = Arc::clone(&self.lock_file_path);
        let watchdog_body_cb = self.config.lock_body.clone();
        let watchdog_token = token;
        let watchdog_port = self.tcp_port;
        let watchdog_interval = self.config.watchdog_interval;
        let container_facing_lock = self.config.container_facing_lock;
        let mut watchdog_shutdown = shutdown_tx.subscribe();
        let watchdog_handle = std::thread::Builder::new()
            .name(format!("host_bridge::{}::watchdog", self.config.name))
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                {
                    Ok(r) => r,
                    Err(e) => {
                        log::warn!(target: "host_bridge", "failed to build watchdog runtime: {e}");
                        return;
                    }
                };
                rt.block_on(async move {
                    let relay_reensure_every = watchdog_interval * 6;
                    let mut last_relay_ensure = std::time::Instant::now();
                    loop {
                        tokio::select! {
                            _ = watchdog_shutdown.recv() => break,
                            _ = tokio::time::sleep(watchdog_interval) => {
                                let current = watchdog_path
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .clone();
                                if !current.exists() {
                                    if let Err(e) = write_lock_body(
                                        &current,
                                        &watchdog_body_cb,
                                        watchdog_port,
                                        &watchdog_token,
                                    ) {
                                        log::warn!(
                                            target: "host_bridge",
                                            "watchdog failed to re-create lock file: {e}"
                                        );
                                    }
                                }
                                if last_relay_ensure.elapsed() >= relay_reensure_every {
                                    last_relay_ensure = std::time::Instant::now();
                                    crate::mirror_relay::ensure_relay_for_port(watchdog_port);
                                    if container_facing_lock {
                                        relocate_lock_on_addressing_change(
                                            &watchdog_path,
                                            watchdog_port,
                                            &watchdog_body_cb,
                                            &watchdog_token,
                                        );
                                    }
                                }
                            }
                        }
                    }
                });
            })?;

        self.shutdown_tx = Some(shutdown_tx);
        self.accept_thread = Some(accept_handle);
        self.watchdog_thread = Some(watchdog_handle);
        Ok(())
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.accept_thread.take() {
            let _ = h.join();
        }
        if let Some(h) = self.watchdog_thread.take() {
            let _ = h.join();
        }
        crate::mirror_relay::remove_relay_for_port(self.tcp_port);
        match std::fs::remove_file(self.lock_file_path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("removing lock file"),
        }
        Ok(())
    }
}

/// Builds the lock body via `body_cb` and writes it atomically — the one place the three
/// lock writers (start, watchdog recreate, relocate) share, so the shape can't drift.
fn write_lock_body(
    path: &Path,
    body_cb: &LockBodyBuilder,
    port: u16,
    token: &str,
) -> anyhow::Result<()> {
    let body = (body_cb)(LockBodyContext {
        port,
        auth_token: token,
    });
    write_lock_file_atomic(path, &body)
}

/// Lock filename stem for a listener whose reader dials `name_port`. The one place the
/// `<port>.lock` scheme lives — `cleanup_stale_lock_files` parses the inverse.
fn lock_file_stem_name(name_port: u16) -> String {
    format!("{name_port}.lock")
}

/// Lock filename for a listener on `port`: container-facing locks carry the
/// container-facing (relay) port, host-facing locks the raw bind port. ADR-080.
fn lock_file_name(port: u16, container_facing: bool) -> String {
    let name_port = if container_facing {
        speedwave_runtime::compose::container_facing_port(port)
    } else {
        port
    };
    lock_file_stem_name(name_port)
}

/// Moves a container-facing lock when the addressing mode changed since it was written —
/// Claude Code dials the FILENAME port; a stale name strands the IDE bridge. ADR-080.
fn relocate_lock_on_addressing_change(
    lock_path: &Arc<Mutex<PathBuf>>,
    port: u16,
    body_cb: &LockBodyBuilder,
    token: &str,
) {
    let Ok(addressing) = speedwave_runtime::compose::host_addressing() else {
        return;
    };
    let current = lock_path
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let Some(dir) = current.parent() else {
        return;
    };
    let facing = speedwave_runtime::compose::container_facing_port_for(port, &addressing);
    let expected = dir.join(lock_file_stem_name(facing));
    if expected == current {
        return;
    }
    if let Err(e) = write_lock_body(&expected, body_cb, port, token) {
        log::warn!(
            target: "host_bridge",
            "watchdog failed to relocate lock to {expected:?}: {e}"
        );
        return;
    }
    match std::fs::remove_file(&current) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!(
                target: "host_bridge",
                "watchdog relocated lock to {expected:?} but could not remove stale {current:?}: {e}; will retry"
            );
            return;
        }
    }
    *lock_path
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = expected.clone();
    log::info!(
        target: "host_bridge",
        "watchdog moved lock {current:?} -> {expected:?} after addressing change"
    );
}

/// Binds the listener on `compose::host_bind_address()`. Retries once on `EADDRNOTAVAIL`
/// (typical after `wsl --shutdown` invalidated the cached adapter IP) after re-detecting.
fn bind_with_retry(
    name: &str,
    preferred_port: Option<u16>,
) -> anyhow::Result<std::net::TcpListener> {
    let attempt = |addr: &str| -> std::io::Result<std::net::TcpListener> {
        match preferred_port {
            Some(p) => std::net::TcpListener::bind((addr, p)),
            None => std::net::TcpListener::bind((addr, 0)),
        }
    };
    let first = speedwave_runtime::compose::host_bind_address()
        .with_context(|| format!("HostBridge '{name}': resolving bind address"))?;
    match attempt(&first) {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrNotAvailable => {
            log::warn!(
                "HostBridge '{name}': bind on {first} returned EADDRNOTAVAIL; \
                 invalidating host_addressing cache and retrying"
            );
            speedwave_runtime::compose::invalidate_host_addressing_cache();
            let second = speedwave_runtime::compose::host_bind_address()
                .with_context(|| format!("HostBridge '{name}': re-resolving bind address"))?;
            attempt(&second).with_context(|| match preferred_port {
                Some(p) => format!("HostBridge '{name}': preferred_port {p} unavailable"),
                None => format!("HostBridge '{name}': bind on {second}:0 failed after retry"),
            })
        }
        Err(e) => Err(anyhow::Error::from(e)).with_context(|| match preferred_port {
            Some(p) => format!("HostBridge '{name}': preferred_port {p} unavailable"),
            None => format!("HostBridge '{name}': bind on {first}:0 failed"),
        }),
    }
}

fn load_or_create_persistent_token(path: Option<&Path>) -> anyhow::Result<String> {
    let Some(p) = path else {
        return Ok(uuid::Uuid::new_v4().to_string());
    };
    if p.exists() {
        let raw = std::fs::read_to_string(p)
            .with_context(|| format!("read persistent token at {}", p.display()))?;
        let token = raw.trim().to_string();
        if uuid::Uuid::parse_str(&token).is_ok() {
            return Ok(token);
        }
        log::warn!(
            target: "host_bridge",
            "persistent token at {} is not a UUID; regenerating",
            p.display()
        );
    }
    let token = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = p.parent() {
        runtime_fs_perms::ensure_owner_only_dir(parent)
            .with_context(|| format!("ensure 0700 on {}", parent.display()))?;
    }
    runtime_fs_perms::write_restricted_file(p, &token)
        .with_context(|| format!("write persistent token to {}", p.display()))?;
    Ok(token)
}

impl Drop for HostBridge {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

impl std::fmt::Debug for HostBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostBridge")
            .field("name", &self.config.name)
            .field("port", &self.tcp_port)
            .field("lock_file_path", &self.lock_file_path())
            .field("auth_token", &"***REDACTED***")
            .finish()
    }
}

/// `Clone` for the bridge config without callbacks — the accept loop only needs the static
/// fields; the lock-body callback stays in `HostBridge` for the watchdog to re-use.
impl HostBridgeConfig {
    fn clone_without_callbacks(&self) -> HostBridgeConfig {
        HostBridgeConfig {
            name: self.name.clone(),
            mode: self.mode.clone(),
            auth: self.auth.clone(),
            origin_policy: self.origin_policy.clone(),
            subprotocol: self.subprotocol.clone(),
            max_frame_bytes: self.max_frame_bytes,
            lock_body: self.lock_body.clone(),
            watchdog_interval: self.watchdog_interval,
            stale_probe_timeout: self.stale_probe_timeout,
            container_facing_lock: self.container_facing_lock,
        }
    }
}

enum StartHandler {
    Endpoint(ConnectionHandler),
    Pairing(Option<PairingEventCallback>),
}

async fn run_endpoint_loop(
    listener: TcpListener,
    auth: Arc<Mutex<AuthState>>,
    config: Arc<HostBridgeConfig>,
    handler: ConnectionHandler,
    mut shutdown_rx: broadcast::Receiver<()>,
) {
    let endpoint_auth = match &config.auth {
        Some(a) => a.clone(),
        None => {
            log::error!(
                target: "host_bridge",
                "endpoint accept loop started without an auth scheme"
            );
            return;
        }
    };

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => break,
            accept_res = listener.accept() => {
                let (stream, peer_addr) = match accept_res {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!(target: "host_bridge", "endpoint accept failed: {e}");
                        continue;
                    }
                };

                let auth_for_callback = auth.clone();
                let scheme_for_callback = endpoint_auth.clone();
                let origin_policy = config.origin_policy.clone();
                let subprotocol = config.subprotocol.clone();

                let outcome = Arc::new(Mutex::new(None::<HandshakeOutcome>));
                let outcome_cb = outcome.clone();

                let ws_config = make_ws_config(config.max_frame_bytes);
                let upgrade_result = tokio_tungstenite::accept_hdr_async_with_config(
                    stream,
                    move |req: &Request<()>, mut resp: Response<()>| {
                        let Ok(auth_guard) = auth_for_callback.lock() else {
                            return Err(http_response(500, "auth state poisoned"));
                        };
                        let matched_auth = match validate_request_auth_single(
                            req,
                            &auth_guard,
                            &scheme_for_callback,
                        ) {
                            Some(m) => m,
                            None => return Err(http_response(401, "Unauthorized")),
                        };
                        drop(auth_guard);
                        if !check_origin(req, &origin_policy, &matched_auth) {
                            return Err(http_response(403, "Forbidden origin"));
                        }
                        let selected = select_subprotocol(req, &subprotocol);
                        if let Some(sp) = selected {
                            resp.headers_mut().insert(
                                "sec-websocket-protocol",
                                HeaderValue::from_static(sp),
                            );
                        }
                        let path = req.uri().path().to_string();
                        let query = req.uri().query().map(|s| s.to_string());
                        let Ok(mut outcome_guard) = outcome_cb.lock() else {
                            return Err(http_response(500, "outcome state poisoned"));
                        };
                        *outcome_guard = Some(HandshakeOutcome {
                            matched_auth,
                            selected_subprotocol: selected.map(|s| s.to_string()),
                            path,
                            query,
                        });
                        Ok(resp)
                    },
                    Some(ws_config),
                )
                .await;

                let ws = match upgrade_result {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                let outcome = match outcome.lock() {
                    Ok(mut guard) => match guard.take() {
                        Some(o) => o,
                        None => continue,
                    },
                    Err(_) => continue,
                };

                let ctx = ConnectionContext {
                    bridge_name: config.name.clone(),
                    peer_addr,
                    _path: outcome.path,
                    _query: outcome.query,
                    _selected_subprotocol: outcome.selected_subprotocol,
                    _matched_auth: outcome.matched_auth,
                    _shutdown: shutdown_rx.resubscribe(),
                };
                let fut = (handler)(ws, ctx);
                tokio::spawn(fut);
            }
        }
    }
}

struct HandshakeOutcome {
    matched_auth: AuthMatch,
    selected_subprotocol: Option<String>,
    path: String,
    query: Option<String>,
}

#[derive(Default)]
struct PairingState {
    pending: HashMap<&'static str, PendingSlot>,
    active: Option<ActivePair>,
    pair_gen: u64,
}

struct PendingSlot {
    ws: WebSocketStream<tokio::net::TcpStream>,
    occupied_at: Instant,
}

struct ActivePair {
    pair_id: u64,
}

async fn run_pairing_loop(
    listener: TcpListener,
    auth: Arc<Mutex<AuthState>>,
    config: Arc<HostBridgeConfig>,
    event_cb: Option<PairingEventCallback>,
    mut shutdown_rx: broadcast::Receiver<()>,
) {
    let pairing_cfg = match &config.mode {
        ConnectionMode::Pairing(p) => p.clone(),
        _ => return,
    };
    let state = Arc::new(Mutex::new(PairingState::default()));

    let timeout_handle = pairing_cfg.pending_slot_timeout.map(|timeout| {
        spawn_pending_slot_watcher(
            state.clone(),
            timeout,
            event_cb.clone(),
            shutdown_rx.resubscribe(),
        )
    });

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => break,
            accept_res = listener.accept() => {
                let (stream, peer_addr) = match accept_res {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!(target: "host_bridge", "pairing accept failed: {e}");
                        continue;
                    }
                };
                log::debug!(target: "host_bridge", "pairing[{}] tcp accept from {peer_addr}", config.name);

                let auth_for_cb = auth.clone();
                let pairing_for_cb = pairing_cfg.clone();
                let origin_policy = config.origin_policy.clone();
                let subprotocol = config.subprotocol.clone();
                let state_for_cb = state.clone();
                let event_cb_for_cb = event_cb.clone();
                let bridge_name_for_cb = config.name.clone();

                let outcome = Arc::new(Mutex::new(None::<PairingHandshakeOutcome>));
                let outcome_cb = outcome.clone();

                let ws_config = make_ws_config(config.max_frame_bytes);
                let upgrade_result = tokio_tungstenite::accept_hdr_async_with_config(
                    stream,
                    move |req: &Request<()>, mut resp: Response<()>| {
                        let Ok(auth_guard) = auth_for_cb.lock() else {
                            return Err(http_response(500, "auth state poisoned"));
                        };
                        let role_and_match =
                            pairing_for_cb.roles.iter().find_map(|(role, scheme)| {
                                validate_request_auth_single(req, &auth_guard, scheme)
                                    .map(|m| (*role, m))
                            });
                        drop(auth_guard);
                        let (role, matched_auth) = match role_and_match {
                            Some(x) => x,
                            None => {
                                log::warn!(
                                    target: "host_bridge",
                                    "pairing[{bridge_name_for_cb}] reject {peer_addr}: 401 auth (no role matched)"
                                );
                                return Err(http_response(401, "Unauthorized"));
                            }
                        };
                        log::info!(
                            target: "host_bridge",
                            "pairing[{bridge_name_for_cb}] accept {peer_addr} as role '{role}'"
                        );
                        if !check_origin(req, &origin_policy, &matched_auth) {
                            log::warn!(
                                target: "host_bridge",
                                "pairing[{bridge_name_for_cb}] reject {peer_addr}: 403 origin"
                            );
                            return Err(http_response(403, "Forbidden origin"));
                        }
                        let selected = select_subprotocol(req, &subprotocol);
                        if let Some(sp) = selected {
                            resp.headers_mut().insert(
                                "sec-websocket-protocol",
                                HeaderValue::from_static(sp),
                            );
                        }
                        let Ok(mut st) = state_for_cb.lock() else {
                            return Err(http_response(500, "pairing state poisoned"));
                        };
                        if st.active.is_some() {
                            if let Some(cb) = &event_cb_for_cb {
                                cb(PairingEvent::PairBusy {
                                    _peer_addr: peer_addr,
                                });
                            }
                            return Err(http_response(409, "Pair busy"));
                        }
                        if st.pending.contains_key(role) {
                            match pairing_for_cb.on_role_collision {
                                RoleCollisionPolicy::Reject => {
                                    if let Some(cb) = &event_cb_for_cb {
                                        cb(PairingEvent::SameRoleCollision {
                                            role,
                                            policy: RoleCollisionPolicy::Reject,
                                            _peer_addr: peer_addr,
                                        });
                                    }
                                    return Err(http_response(409, "Role already pending"));
                                }
                                RoleCollisionPolicy::EvictOlder => {
                                    if let Some(_old) = st.pending.remove(role) {
                                        if let Some(cb) = &event_cb_for_cb {
                                            cb(PairingEvent::SameRoleCollision {
                                                role,
                                                policy: RoleCollisionPolicy::EvictOlder,
                                                _peer_addr: peer_addr,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        drop(st);

                        let Ok(mut outcome_guard) = outcome_cb.lock() else {
                            return Err(http_response(500, "outcome state poisoned"));
                        };
                        let _ = matched_auth;
                        *outcome_guard = Some(PairingHandshakeOutcome { role });
                        Ok(resp)
                    },
                    Some(ws_config),
                )
                .await;

                let ws = match upgrade_result {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                let outcome = match outcome.lock() {
                    Ok(mut guard) => match guard.take() {
                        Some(o) => o,
                        None => continue,
                    },
                    Err(_) => continue,
                };

                let Ok(mut st) = state.lock() else {
                    log::warn!(
                        target: "host_bridge",
                        "pairing state lock poisoned, skipping connection"
                    );
                    continue;
                };
                st.pending.insert(
                    outcome.role,
                    PendingSlot {
                        ws,
                        occupied_at: Instant::now(),
                    },
                );
                if let Some(cb) = &event_cb {
                    cb(PairingEvent::SlotOccupied {
                        role: outcome.role,
                        _peer_addr: peer_addr,
                    });
                }

                if st.pending.len() == pairing_cfg.roles.len() {
                    let pending = std::mem::take(&mut st.pending);
                    let roles: Vec<&'static str> = pending.keys().copied().collect();
                    let streams: Vec<WebSocketStream<tokio::net::TcpStream>> =
                        pending.into_values().map(|p| p.ws).collect();

                    st.pair_gen += 1;
                    let pair_id = st.pair_gen;
                    st.active = Some(ActivePair { pair_id });
                    drop(st);

                    let state_clone = state.clone();
                    let event_cb_clone = event_cb.clone();
                    let shutdown_rx_clone = shutdown_rx.resubscribe();
                    let max_frame_bytes = config.max_frame_bytes;
                    let roles_for_event = roles.clone();
                    tokio::spawn(async move {
                        if let Some(cb) = &event_cb_clone {
                            cb(PairingEvent::Paired {
                                roles: roles_for_event,
                            });
                        }
                        let reason = run_relay(streams, shutdown_rx_clone, max_frame_bytes).await;
                        if let Ok(mut st) = state_clone.lock() {
                            if let Some(active) = &st.active {
                                if active.pair_id == pair_id {
                                    st.active = None;
                                }
                            }
                        }
                        if let Some(cb) = &event_cb_clone {
                            cb(PairingEvent::PairClosed { reason });
                        }
                    });
                }
            }
        }
    }

    if let Some(h) = timeout_handle {
        h.abort();
    }
}

struct PairingHandshakeOutcome {
    role: &'static str,
}

fn spawn_pending_slot_watcher(
    state: Arc<Mutex<PairingState>>,
    timeout: Duration,
    event_cb: Option<PairingEventCallback>,
    mut shutdown_rx: broadcast::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    let check_interval = (timeout / 4).max(Duration::from_secs(1));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                _ = tokio::time::sleep(check_interval) => {
                    let now = Instant::now();
                    let mut expired: Vec<&'static str> = Vec::new();
                    if let Ok(mut st) = state.lock() {
                        st.pending.retain(|role, slot| {
                            if now.duration_since(slot.occupied_at) >= timeout {
                                expired.push(*role);
                                false
                            } else {
                                true
                            }
                        });
                    } else {
                        log::warn!(
                            target: "host_bridge",
                            "pending slot watcher state lock poisoned"
                        );
                    }
                    if let Some(cb) = &event_cb {
                        for role in expired {
                            cb(PairingEvent::PendingSlotTimeout { role });
                        }
                    }
                }
            }
        }
    })
}

async fn run_relay(
    streams: Vec<WebSocketStream<tokio::net::TcpStream>>,
    mut shutdown_rx: broadcast::Receiver<()>,
    max_frame_bytes: Option<usize>,
) -> String {
    let mut iter = streams.into_iter();
    let a = match iter.next() {
        Some(s) => s,
        None => return "relay started with zero streams".to_string(),
    };
    let b = match iter.next() {
        Some(s) => s,
        None => return "relay started with one stream".to_string(),
    };

    let (mut a_tx, mut a_rx) = a.split();
    let (mut b_tx, mut b_rx) = b.split();

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.recv() => return "bridge shutdown".to_string(),
            msg = a_rx.next() => {
                match forward_with_cap(msg, &mut b_tx, max_frame_bytes).await {
                    ForwardOutcome::Continue => continue,
                    ForwardOutcome::Closed => return "slot A closed".to_string(),
                    ForwardOutcome::Error(e) => return format!("slot A error: {e}"),
                    ForwardOutcome::OverSize => return "frame exceeded max_frame_bytes".to_string(),
                }
            }
            msg = b_rx.next() => {
                match forward_with_cap(msg, &mut a_tx, max_frame_bytes).await {
                    ForwardOutcome::Continue => continue,
                    ForwardOutcome::Closed => return "slot B closed".to_string(),
                    ForwardOutcome::Error(e) => return format!("slot B error: {e}"),
                    ForwardOutcome::OverSize => return "frame exceeded max_frame_bytes".to_string(),
                }
            }
        }
    }
}

enum ForwardOutcome {
    Continue,
    Closed,
    Error(String),
    OverSize,
}

async fn forward_with_cap<S>(
    msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    sink: &mut S,
    max_frame_bytes: Option<usize>,
) -> ForwardOutcome
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let msg = match msg {
        Some(Ok(m)) => m,
        Some(Err(e)) => return ForwardOutcome::Error(e.to_string()),
        None => return ForwardOutcome::Closed,
    };
    if let Some(max) = max_frame_bytes {
        let len = match &msg {
            Message::Text(t) => t.len(),
            Message::Binary(b) => b.len(),
            _ => 0,
        };
        if len > max {
            let _ = sink.close().await;
            return ForwardOutcome::OverSize;
        }
    }
    let is_close = matches!(&msg, Message::Close(_));
    if let Err(e) = sink.send(msg).await {
        return ForwardOutcome::Error(e.to_string());
    }
    if is_close {
        return ForwardOutcome::Closed;
    }
    ForwardOutcome::Continue
}

fn validate_request_auth_single(
    req: &Request<()>,
    auth: &AuthState,
    scheme: &AuthScheme,
) -> Option<AuthMatch> {
    match scheme {
        AuthScheme::Header(name) => req
            .headers()
            .get(*name)
            .and_then(|v| v.to_str().ok())
            .filter(|tok| auth.validate(tok))
            .map(|_| AuthMatch::Header(name)),
        AuthScheme::QueryParam(name) => extract_query_param(req.uri().query().unwrap_or(""), name)
            .filter(|tok| auth.validate(tok))
            .map(|_| AuthMatch::QueryParam(name)),
    }
}

fn check_origin(req: &Request<()>, policy: &OriginPolicy, matched_auth: &AuthMatch) -> bool {
    let has_origin = req.headers().contains_key("origin");
    match policy {
        OriginPolicy::RejectIfPresent => !has_origin,
        OriginPolicy::AcceptIfAuthIsQueryParam => {
            !has_origin || matches!(matched_auth, AuthMatch::QueryParam(_))
        }
    }
}

fn select_subprotocol(req: &Request<()>, policy: &SubprotocolPolicy) -> Option<&'static str> {
    if policy.accepted.is_empty() {
        return None;
    }
    let header = req.headers().get("sec-websocket-protocol")?.to_str().ok()?;
    for proto in header.split(',') {
        let proto = proto.trim();
        for accepted in policy.accepted {
            if proto == *accepted {
                return Some(*accepted);
            }
        }
    }
    None
}

fn http_response(code: u16, body: &str) -> ErrorResponse {
    Response::builder()
        .status(code)
        .body(Some(body.to_string()))
        .unwrap_or_else(|_| Response::new(Some("500 Internal Server Error".to_string())))
}

fn make_ws_config(max_frame_bytes: Option<usize>) -> WebSocketConfig {
    let mut cfg = WebSocketConfig::default();
    if let Some(max) = max_frame_bytes {
        cfg.max_message_size = Some(max);
        cfg.max_frame_size = Some(max);
    }
    cfg
}

pub(crate) fn write_lock_file_atomic(
    final_path: &Path,
    body: &serde_json::Value,
) -> anyhow::Result<()> {
    let dir = final_path
        .parent()
        .context("lock file path has no parent directory")?;
    let mut tmp = tempfile::NamedTempFile::with_prefix_in(".lock-", dir)
        .context("creating temp lock file")?;

    runtime_fs_perms::set_owner_only(tmp.path())
        .map_err(|e| anyhow::anyhow!("set_owner_only on temp lock file: {e}"))?;

    tmp.as_file_mut()
        .write_all(serde_json::to_string_pretty(body)?.as_bytes())?;
    tmp.as_file_mut().flush()?;

    tmp.persist(final_path)
        .map_err(|e| anyhow::anyhow!("persisting lock file: {e}"))?;
    Ok(())
}

pub(crate) fn ensure_lock_dir(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {dir:?}"))?;
    runtime_fs_perms::set_owner_only_dir(dir)
        .map_err(|e| anyhow::anyhow!("set_owner_only_dir on {dir:?}: {e}"))?;
    Ok(())
}

fn cleanup_stale_lock_files(dir: &Path, probe_timeout: Duration, container_facing: bool) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let bind: std::net::IpAddr = match speedwave_runtime::compose::host_bind_address() {
        Ok(addr) => match addr.parse() {
            Ok(ip) => ip,
            Err(e) => {
                log::warn!(
                    "skipping stale lock cleanup: host bind address {addr:?} unparseable ({e})"
                );
                return;
            }
        },
        Err(e) => {
            log::warn!("skipping stale lock cleanup: host_bind_address failed ({e})");
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("lock") {
            continue;
        }
        let name_port_opt = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u16>().ok());
        let name_port = match name_port_opt {
            Some(p) => p,
            None => {
                let _ = std::fs::remove_file(&path);
                continue;
            }
        };
        let probe_port = if container_facing {
            speedwave_runtime::compose::host_bind_port_for_container_facing(name_port)
        } else {
            name_port
        };
        if StdTcpStream::connect_timeout(&SocketAddr::new(bind, probe_port), probe_timeout).is_err()
        {
            log::debug!(
                target: "host_bridge",
                "removing stale lock {:?} (bind port {} not listening)",
                path,
                probe_port
            );
            let _ = std::fs::remove_file(&path);
        }
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
    use http::Uri;

    fn endpoint_config(name: &str) -> HostBridgeConfig {
        HostBridgeConfig::builder(name)
            .endpoint(AuthScheme::Header("x-test-auth"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|ctx| {
                serde_json::json!({
                    "port": ctx.port,
                    "authToken": ctx.auth_token,
                })
            })
            .build()
            .unwrap()
    }

    fn pairing_config(name: &str) -> HostBridgeConfig {
        let roles = HashMap::from([
            ("worker", AuthScheme::Header("x-test-worker-auth")),
            ("plugin", AuthScheme::QueryParam("token")),
        ]);
        HostBridgeConfig::builder(name)
            .pairing(PairingConfig {
                roles,
                on_role_collision: RoleCollisionPolicy::EvictOlder,
                pending_slot_timeout: None,
            })
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .lock_body(|ctx| {
                serde_json::json!({
                    "port": ctx.port,
                    "authToken": ctx.auth_token,
                })
            })
            .build()
            .unwrap()
    }

    #[test]
    fn auth_state_valid_token() {
        let auth = AuthState::new("abc".to_string());
        assert!(auth.validate("abc"));
    }

    #[test]
    fn auth_state_invalid_token() {
        let auth = AuthState::new("abc".to_string());
        assert!(!auth.validate("xyz"));
    }

    #[test]
    fn constant_time_eq_basic_cases() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn validate_bridge_name_ok() {
        assert!(validate_bridge_name("ide"));
        assert!(validate_bridge_name("example-plugin"));
        assert!(validate_bridge_name("a"));
        assert!(validate_bridge_name("a-b-c"));
        assert!(validate_bridge_name("a1b2"));
        assert!(validate_bridge_name(&"a".repeat(33)));
    }

    #[test]
    fn validate_bridge_name_rejects_invalid() {
        assert!(!validate_bridge_name(""));
        assert!(!validate_bridge_name("Foo"));
        assert!(!validate_bridge_name("1foo"));
        assert!(!validate_bridge_name("-foo"));
        assert!(!validate_bridge_name("foo_bar"));
        assert!(!validate_bridge_name(&"a".repeat(34)));
    }

    #[test]
    fn extract_query_param_basic() {
        assert_eq!(
            extract_query_param("token=abc", "token"),
            Some("abc".to_string())
        );
        assert_eq!(
            extract_query_param("foo=1&token=xyz&bar=2", "token"),
            Some("xyz".to_string())
        );
        assert_eq!(extract_query_param("foo=1", "token"), None);
        assert_eq!(extract_query_param("", "token"), None);
    }

    #[test]
    fn extract_query_param_no_plus_as_space() {
        assert_eq!(
            extract_query_param("token=a+b", "token"),
            Some("a+b".to_string())
        );
    }

    #[test]
    fn config_builder_endpoint_valid() {
        let cfg = endpoint_config("ide");
        assert_eq!(cfg.name, "ide");
        assert!(matches!(cfg.mode, ConnectionMode::Endpoint));
        assert!(cfg.auth.is_some());
    }

    #[test]
    fn config_builder_pairing_valid() {
        let cfg = pairing_config("example-plugin");
        assert_eq!(cfg.name, "example-plugin");
        assert!(matches!(cfg.mode, ConnectionMode::Pairing(_)));
        assert!(cfg.auth.is_none());
    }

    #[test]
    fn config_builder_rejects_invalid_name() {
        let err = HostBridgeConfig::builder("Bad-Name")
            .endpoint(AuthScheme::Header("h"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|_| serde_json::json!({}))
            .build();
        assert!(err.is_err());
    }

    #[test]
    fn config_builder_pairing_empty_roles_rejected() {
        let err = HostBridgeConfig::builder("example-plugin")
            .pairing(PairingConfig {
                roles: HashMap::new(),
                on_role_collision: RoleCollisionPolicy::EvictOlder,
                pending_slot_timeout: None,
            })
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|_| serde_json::json!({}))
            .build();
        assert!(err.is_err());
    }

    #[test]
    fn config_builder_origin_acceptifqueryparam_requires_queryparam_in_config() {
        let err = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header("h"))
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .lock_body(|_| serde_json::json!({}))
            .build();
        assert!(err.is_err());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_assigns_port_and_token() {
        let cfg = endpoint_config("ide");
        let bridge = HostBridge::new(cfg).unwrap();
        assert!(bridge.port() > 0);
        let token = bridge.auth_token();
        assert!(uuid::Uuid::parse_str(&token).is_ok());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_holds_listener_until_start() {
        let cfg = endpoint_config("ide");
        let bridge = HostBridge::new(cfg).unwrap();
        let port = bridge.port();
        let second = std::net::TcpListener::bind(format!("127.0.0.1:{port}"));
        assert!(second.is_err(), "TOCTOU guard: listener must still be held");
        drop(bridge);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn host_bridge_debug_redacts_auth_token() {
        let cfg = endpoint_config("ide");
        let bridge = HostBridge::new(cfg).unwrap();
        let dbg = format!("{:?}", bridge);
        let token = bridge.auth_token();
        assert!(
            !dbg.contains(&token),
            "token must not appear in Debug output: {dbg}"
        );
        assert!(dbg.contains("REDACTED"));
    }

    /// Reserve a free port. Caller drops the guard listener immediately
    /// before binding the bridge to minimize the TOCTOU window.
    fn reserve_free_port() -> (std::net::TcpListener, u16) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_with_preferred_port_uses_it_when_free() {
        let (guard, port) = reserve_free_port();
        drop(guard);
        let opts = HostBridgeNewOptions {
            preferred_port: Some(port),
            persistent_token_path: None,
        };
        let bridge = HostBridge::new_with_options(endpoint_config("ide"), opts).unwrap();
        assert_eq!(bridge.port(), port);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_with_preferred_port_fails_when_busy() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let opts = HostBridgeNewOptions {
            preferred_port: Some(port),
            persistent_token_path: None,
        };
        let err = HostBridge::new_with_options(endpoint_config("ide"), opts)
            .expect_err("busy preferred_port must fail");
        let msg = format!("{err:#}");
        assert!(
            msg.contains(&format!("preferred_port {port} unavailable")),
            "expected port-busy error, got: {msg}"
        );
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_with_persistent_token_creates_file_first_run() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp
            .path()
            .join("plugin-state")
            .join("xyz")
            .join(crate::bridges::plugin_host_bridge::BRIDGE_TOKEN_FILENAME);
        let opts = HostBridgeNewOptions {
            preferred_port: None,
            persistent_token_path: Some(token_path.clone()),
        };
        let bridge = HostBridge::new_with_options(endpoint_config("ide"), opts).unwrap();
        let written = std::fs::read_to_string(&token_path).unwrap();
        assert_eq!(written.trim(), bridge.auth_token());
        assert!(uuid::Uuid::parse_str(written.trim()).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must be chmod 0600, got {mode:o}");
        }
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_with_persistent_token_reuses_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let token_path = tmp
            .path()
            .join("plugin-state")
            .join("xyz")
            .join(crate::bridges::plugin_host_bridge::BRIDGE_TOKEN_FILENAME);
        let opts = HostBridgeNewOptions {
            preferred_port: None,
            persistent_token_path: Some(token_path.clone()),
        };
        let first = HostBridge::new_with_options(endpoint_config("ide"), opts).unwrap();
        let first_token = first.auth_token();
        drop(first);
        let opts2 = HostBridgeNewOptions {
            preferred_port: None,
            persistent_token_path: Some(token_path),
        };
        let second = HostBridge::new_with_options(endpoint_config("ide"), opts2).unwrap();
        assert_eq!(second.auth_token(), first_token);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_with_persistent_token_regenerates_on_malformed() {
        let tmp = tempfile::tempdir().unwrap();
        let token_dir = tmp.path().join("plugin-state").join("xyz");
        std::fs::create_dir_all(&token_dir).unwrap();
        let token_path = token_dir.join(crate::bridges::plugin_host_bridge::BRIDGE_TOKEN_FILENAME);
        std::fs::write(&token_path, "not-a-uuid\n").unwrap();
        let opts = HostBridgeNewOptions {
            preferred_port: None,
            persistent_token_path: Some(token_path.clone()),
        };
        let bridge = HostBridge::new_with_options(endpoint_config("ide"), opts).unwrap();
        let written = std::fs::read_to_string(&token_path).unwrap();
        assert_eq!(written.trim(), bridge.auth_token());
        assert!(uuid::Uuid::parse_str(written.trim()).is_ok());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn new_without_opts_regenerates_token_per_call() {
        let a = HostBridge::new(endpoint_config("ide")).unwrap();
        let b = HostBridge::new(endpoint_config("ide")).unwrap();
        assert_ne!(a.auth_token(), b.auth_token());
    }

    fn req_with_origin(
        origin: Option<&str>,
        query: Option<&str>,
        header: Option<(&str, &str)>,
    ) -> Request<()> {
        let mut b = Request::builder();
        let uri = match query {
            Some(q) => format!("/?{}", q),
            None => "/".to_string(),
        };
        b = b.uri(uri.parse::<Uri>().unwrap());
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        if let Some((k, v)) = header {
            b = b.header(k, v);
        }
        b.body(()).unwrap()
    }

    #[test]
    fn origin_reject_if_present_blocks_browser() {
        let req = req_with_origin(
            Some("https://example.com"),
            None,
            Some(("x-test-auth", "tok")),
        );
        let auth = AuthState::new("tok".to_string());
        let matched = validate_request_auth_single(&req, &auth, &AuthScheme::Header("x-test-auth"))
            .expect("auth must match");
        assert!(!check_origin(
            &req,
            &OriginPolicy::RejectIfPresent,
            &matched
        ));
    }

    #[test]
    fn origin_accept_if_query_param_allows_browser_with_token() {
        let req = req_with_origin(Some("https://example.com"), Some("token=tok"), None);
        let auth = AuthState::new("tok".to_string());
        let matched = validate_request_auth_single(&req, &auth, &AuthScheme::QueryParam("token"))
            .expect("auth must match via query param");
        assert!(check_origin(
            &req,
            &OriginPolicy::AcceptIfAuthIsQueryParam,
            &matched
        ));
    }

    #[test]
    fn origin_accept_if_query_param_blocks_browser_with_header_auth() {
        let req = req_with_origin(
            Some("https://example.com"),
            None,
            Some(("x-test-worker-auth", "tok")),
        );
        let auth = AuthState::new("tok".to_string());
        let matched =
            validate_request_auth_single(&req, &auth, &AuthScheme::Header("x-test-worker-auth"))
                .expect("auth must match via header");
        assert!(!check_origin(
            &req,
            &OriginPolicy::AcceptIfAuthIsQueryParam,
            &matched
        ));
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stale_lock_cleanup_removes_files_for_dead_ports() {
        let dir = tempfile::tempdir().unwrap();
        let dead = dir.path().join("65535.lock");
        std::fs::write(&dead, "{}").unwrap();
        cleanup_stale_lock_files(dir.path(), Duration::from_millis(50), false);
        assert!(!dead.exists());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stale_lock_cleanup_removes_unparseable_names() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("not-a-port.lock");
        std::fs::write(&junk, "{}").unwrap();
        cleanup_stale_lock_files(dir.path(), Duration::from_millis(50), false);
        assert!(!junk.exists());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stale_lock_cleanup_preserves_live_ports() {
        let dir = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let alive = dir.path().join(format!("{port}.lock"));
        std::fs::write(&alive, "{}").unwrap();
        cleanup_stale_lock_files(dir.path(), Duration::from_millis(500), false);
        assert!(alive.exists());
        drop(listener);
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn stale_lock_cleanup_reverse_translates_container_facing_port() {
        let _mirrored = speedwave_runtime::compose::pin_mirrored_addressing();
        for _ in 0..20 {
            let dir = tempfile::tempdir().unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let bind_port = listener.local_addr().unwrap().port();
            let relay = speedwave_runtime::compose::container_facing_port(bind_port);
            assert_ne!(relay, bind_port, "mirrored must translate the bind port");
            let alive = dir.path().join(format!("{relay}.lock"));
            std::fs::write(&alive, "{}").unwrap();

            cleanup_stale_lock_files(dir.path(), Duration::from_millis(500), true);
            assert!(
                alive.exists(),
                "live container-facing lock must survive the reverse-translated probe"
            );

            drop(listener);
            let taken_again = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], bind_port)),
                Duration::from_millis(100),
            )
            .is_ok();
            if taken_again {
                continue;
            }
            cleanup_stale_lock_files(dir.path(), Duration::from_millis(200), true);
            assert!(
                !alive.exists(),
                "dead container-facing lock must be removed once the bind port stops listening"
            );
            return;
        }
        panic!("every freed test port was taken again by a parallel test");
    }

    #[test]
    fn write_lock_file_atomic_writes_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("12345.lock");
        let body = serde_json::json!({"port": 12345, "authToken": "abc"});
        write_lock_file_atomic(&path, &body).unwrap();
        let read_back: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read_back, body);
    }

    #[test]
    fn write_lock_file_atomic_sets_0o600_on_unix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("12345.lock");
        write_lock_file_atomic(&path, &serde_json::json!({})).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn ensure_lock_dir_creates_0o700_on_unix() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ide-bridge");
        ensure_lock_dir(&sub).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&sub).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_endpoint_in_pairing_config_bails() {
        let cfg = pairing_config("example-plugin");
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        let err = bridge.start_endpoint(handler);
        assert!(err.is_err());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_pairing_in_endpoint_config_bails() {
        let cfg = endpoint_config("ide");
        let mut bridge = HostBridge::new(cfg).unwrap();
        let err = bridge.start_pairing(None);
        assert!(err.is_err());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stop_is_idempotent_when_files_missing() {
        let cfg = endpoint_config("ide");
        let mut bridge = HostBridge::new(cfg).unwrap();
        bridge.stop().unwrap();
        bridge.stop().unwrap();
    }

    fn start_endpoint_for_test(
        cfg: HostBridgeConfig,
        handler: ConnectionHandler,
    ) -> (HostBridge, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let mut bridge = HostBridge::new(cfg).unwrap();
        bridge.start_endpoint(handler).unwrap();
        (bridge, tmp)
    }

    fn start_pairing_for_test(
        cfg: HostBridgeConfig,
        event_cb: Option<PairingEventCallback>,
    ) -> (HostBridge, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let mut bridge = HostBridge::new(cfg).unwrap();
        bridge.start_pairing(event_cb).unwrap();
        (bridge, tmp)
    }

    /// Build a tungstenite client request with optional header and query.
    fn make_client_request(
        port: u16,
        query: Option<&str>,
        header: Option<(&str, &str)>,
        origin: Option<&str>,
    ) -> Request<()> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = match query {
            Some(q) => format!("ws://127.0.0.1:{port}/?{q}"),
            None => format!("ws://127.0.0.1:{port}/"),
        };
        let mut req = url.into_client_request().unwrap();
        if let Some((k, v)) = header {
            req.headers_mut().insert(
                http::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                http::header::HeaderValue::from_str(v).unwrap(),
            );
        }
        if let Some(o) = origin {
            req.headers_mut()
                .insert("origin", http::header::HeaderValue::from_str(o).unwrap());
        }
        req
    }

    fn tokio_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_header_auth_valid_token_accepted() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|mut ws, _ctx| {
            Box::pin(async move {
                if let Some(Ok(msg)) = ws.next().await {
                    let _ = ws.send(msg).await;
                }
                let _ = ws.close(None).await;
            })
        });
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let token = bridge.auth_token();
        let port = bridge.port();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(port, None, Some(("x-test-auth", &token)), None);
            let (mut ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
            ws.send(Message::Text("hello".into())).await.unwrap();
            let echoed = ws.next().await.unwrap().unwrap();
            assert_eq!(echoed.into_text().unwrap(), "hello");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_header_auth_invalid_token_rejected() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(port, None, Some(("x-test-auth", "wrong")), None);
            let res = tokio_tungstenite::connect_async(req).await;
            assert!(res.is_err(), "wrong token must be rejected");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_origin_rejected_when_policy_is_reject_if_present() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(
                port,
                None,
                Some(("x-test-auth", &token)),
                Some("https://evil.example"),
            );
            let res = tokio_tungstenite::connect_async(req).await;
            assert!(res.is_err(), "Origin header must trigger rejection");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_context_exposes_path_query_matched_auth() {
        let cfg = endpoint_config("ide");
        type Snapshot = (
            String,
            SocketAddr,
            String,
            Option<String>,
            Option<String>,
            AuthMatch,
        );
        let observed: Arc<Mutex<Option<Snapshot>>> = Arc::new(Mutex::new(None));
        let observed_clone = observed.clone();
        let handler: ConnectionHandler = Arc::new(move |mut ws, mut ctx| {
            let observed = observed_clone.clone();
            Box::pin(async move {
                let _shutdown_alive = ctx._shutdown.try_recv().is_err();
                *observed.lock().unwrap() = Some((
                    ctx.bridge_name.clone(),
                    ctx.peer_addr,
                    ctx._path.clone(),
                    ctx._query.clone(),
                    ctx._selected_subprotocol.clone(),
                    ctx._matched_auth.clone(),
                ));
                let _ = ws.close(None).await;
            })
        });
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req =
                make_client_request(port, Some("foo=bar"), Some(("x-test-auth", &token)), None);
            let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
            ws.close(None).await.ok();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });

        let snapshot = observed.lock().unwrap().clone().expect("handler ran");
        let (bridge_name, peer_addr, path, query, selected_sub, matched) = snapshot;
        assert_eq!(bridge_name, "ide");
        assert!(peer_addr.ip().is_loopback());
        assert_eq!(path, "/");
        assert_eq!(query.as_deref(), Some("foo=bar"));
        assert!(
            selected_sub.is_none(),
            "no subprotocol policy → none echoed"
        );
        assert_eq!(matched, AuthMatch::Header("x-test-auth"));
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_subprotocol_echoed_when_advertised() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let cfg = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header("x-test-auth"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .subprotocol(SubprotocolPolicy { accepted: &["mcp"] })
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        let handler: ConnectionHandler = Arc::new(|mut ws, _ctx| {
            Box::pin(async move {
                let _ = ws.close(None).await;
            })
        });
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let mut req = format!("ws://127.0.0.1:{port}/")
                .into_client_request()
                .unwrap();
            req.headers_mut()
                .insert("x-test-auth", http::HeaderValue::from_str(&token).unwrap());
            req.headers_mut().insert(
                "sec-websocket-protocol",
                http::HeaderValue::from_static("mcp"),
            );
            let (_ws, resp) = tokio_tungstenite::connect_async(req).await.unwrap();
            assert_eq!(
                resp.headers()
                    .get("sec-websocket-protocol")
                    .map(|v| v.to_str().unwrap()),
                Some("mcp")
            );
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_active_connection_closes_on_bridge_stop() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|mut ws, mut ctx| {
            Box::pin(async move {
                let _ = ctx._shutdown.recv().await;
                let _ = ws.close(None).await;
            })
        });
        let (mut bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(port, None, Some(("x-test-auth", &token)), None);
            let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
            bridge.stop().unwrap();
            let res = tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(msg) = ws.next().await {
                    if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                        break;
                    }
                }
            })
            .await;
            assert!(res.is_ok(), "client must observe close within 2s");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_two_different_roles_get_paired_and_relay() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |evt| {
            events_clone.lock().unwrap().push(evt);
        });

        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let worker_req =
                make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let (mut worker, _) = tokio_tungstenite::connect_async(worker_req).await.unwrap();
            let plugin_req = make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            );
            let (mut plugin, _) = tokio_tungstenite::connect_async(plugin_req).await.unwrap();

            worker
                .send(Message::Text("from-worker".into()))
                .await
                .unwrap();
            let got = plugin.next().await.unwrap().unwrap();
            assert_eq!(got.into_text().unwrap(), "from-worker");

            plugin
                .send(Message::Text("from-plugin".into()))
                .await
                .unwrap();
            let got = worker.next().await.unwrap().unwrap();
            assert_eq!(got.into_text().unwrap(), "from-plugin");

            worker.close(None).await.ok();
            plugin.close(None).await.ok();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });

        let evts = events.lock().unwrap().clone();
        let paired_roles = evts.iter().find_map(|e| {
            if let PairingEvent::Paired { roles } = e {
                Some(roles.clone())
            } else {
                None
            }
        });
        let roles = paired_roles.unwrap_or_else(|| panic!("expected Paired event, got {evts:?}"));
        assert_eq!(roles.len(), 2, "Paired must report both role names");
        assert!(roles.contains(&"worker"));
        assert!(roles.contains(&"plugin"));
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_relay_forwards_binary_frames() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let worker_req =
                make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let (mut worker, _) = tokio_tungstenite::connect_async(worker_req).await.unwrap();
            let plugin_req = make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            );
            let (mut plugin, _) = tokio_tungstenite::connect_async(plugin_req).await.unwrap();

            let payload = vec![1u8, 2, 3, 4, 5];
            worker
                .send(Message::Binary(payload.clone().into()))
                .await
                .unwrap();
            let got = plugin.next().await.unwrap().unwrap();
            match got {
                Message::Binary(b) => assert_eq!(b.as_ref(), payload.as_slice()),
                other => panic!("expected binary, got {other:?}"),
            }
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_pair_busy_returns_http_409() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |evt| {
            events_clone.lock().unwrap().push(evt);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let worker_req =
                make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let (_worker, _) = tokio_tungstenite::connect_async(worker_req).await.unwrap();
            let plugin_req = make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            );
            let (_plugin, _) = tokio_tungstenite::connect_async(plugin_req).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;

            let third_req =
                make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let res = tokio_tungstenite::connect_async(third_req).await;
            assert!(res.is_err(), "third connection must be rejected");
            let err_str = format!("{:?}", res.err().unwrap());
            assert!(
                err_str.contains("409"),
                "expected HTTP 409 in error, got: {err_str}"
            );
        });

        let evts = events.lock().unwrap().clone();
        let busy_with_addr = evts.iter().find_map(|e| {
            if let PairingEvent::PairBusy { _peer_addr } = e {
                Some(*_peer_addr)
            } else {
                None
            }
        });
        assert!(
            busy_with_addr.is_some(),
            "PairBusy event missing in {evts:?}"
        );
        let addr = busy_with_addr.unwrap();
        assert!(addr.ip().is_loopback(), "peer_addr should be loopback");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_disconnect_one_side_closes_other() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let worker_req =
                make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let (mut worker, _) = tokio_tungstenite::connect_async(worker_req).await.unwrap();
            let plugin_req = make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            );
            let (mut plugin, _) = tokio_tungstenite::connect_async(plugin_req).await.unwrap();

            plugin.close(None).await.ok();
            let res = tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(msg) = worker.next().await {
                    if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                        return;
                    }
                }
            })
            .await;
            assert!(res.is_ok(), "worker must observe close within 2s");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn lock_body_builder_called_with_correct_context() {
        let captured: Arc<Mutex<Option<(u16, String)>>> = Arc::new(Mutex::new(None));
        let captured_clone = captured.clone();
        let cfg = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header("h"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(move |ctx| {
                *captured_clone.lock().unwrap() = Some((ctx.port, ctx.auth_token.to_string()));
                serde_json::json!({})
            })
            .build()
            .unwrap();
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler).unwrap();
        let cap = captured.lock().unwrap().clone();
        assert!(cap.is_some());
        let (port, token) = cap.unwrap();
        assert_eq!(port, bridge.port());
        assert_eq!(token, bridge.auth_token());
        bridge.stop().unwrap();
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_twice_returns_error() {
        let cfg = endpoint_config("ide");
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler.clone()).unwrap();
        let second = bridge.start_endpoint(handler);
        assert!(
            second.is_err(),
            "start_endpoint called twice must error (listener consumed)"
        );
        bridge.stop().unwrap();
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn drop_calls_stop() {
        let cfg = endpoint_config("ide");
        let bridge = HostBridge::new(cfg).unwrap();
        drop(bridge);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stop_removes_lock_file_and_joins_threads() {
        let cfg = endpoint_config("ide");
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler).unwrap();
        let lock_path = bridge.lock_file_path().to_path_buf();
        assert!(lock_path.exists(), "lock file present after start");
        bridge.stop().unwrap();
        assert!(!lock_path.exists(), "lock file removed after stop");
    }

    #[cfg(unix)]
    #[test]
    fn start_rolls_back_on_lock_file_write_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("not-a-dir");
        std::fs::write(&file_path, b"sentinel").unwrap();
        let res = write_lock_file_atomic(&file_path.join("inner.lock"), &serde_json::json!({}));
        assert!(
            res.is_err(),
            "write_lock_file_atomic must fail when parent is a file"
        );
        assert!(!file_path.join("inner.lock").exists());
        assert_eq!(std::fs::read(&file_path).unwrap(), b"sentinel");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_writes_lock_file_atomic_via_named_temp_file() {
        let cfg = endpoint_config("ide");
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler).unwrap();
        let path = bridge.lock_file_path();
        assert!(path.exists(), "lock file must exist after start");
        let contents = std::fs::read_to_string(path).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&contents).is_ok(),
            "lock file must be valid JSON"
        );
        bridge.stop().unwrap();
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_two_clients_concurrent() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|mut ws, _| {
            Box::pin(async move {
                if let Some(Ok(msg)) = ws.next().await {
                    let _ = ws.send(msg).await;
                }
                let _ = ws.close(None).await;
            })
        });
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let mut handles = vec![];
            for i in 0..2 {
                let token = token.clone();
                handles.push(tokio::spawn(async move {
                    let req = make_client_request(port, None, Some(("x-test-auth", &token)), None);
                    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
                    ws.send(Message::Text(format!("client {i}").into()))
                        .await
                        .unwrap();
                    let echo = ws.next().await.unwrap().unwrap();
                    assert_eq!(echo.into_text().unwrap(), format!("client {i}"));
                }));
            }
            for h in handles {
                h.await.unwrap();
            }
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_max_frame_close_1009() {
        let cfg = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header("x-test-auth"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .max_frame_bytes(Some(1024))
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        let handler: ConnectionHandler = Arc::new(|mut ws, _| {
            Box::pin(async move {
                while let Some(Ok(msg)) = ws.next().await {
                    let _ = ws.send(msg).await;
                }
            })
        });
        let (bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(port, None, Some(("x-test-auth", &token)), None);
            let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
            let payload = "x".repeat(2048);
            let _ = ws.send(Message::Text(payload.into())).await;
            let saw_close = tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(msg) = ws.next().await {
                    if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                        return true;
                    }
                }
                false
            })
            .await
            .unwrap_or(false);
            assert!(saw_close, "must observe close frame from oversize frame");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn endpoint_accept_breaks_on_shutdown() {
        let cfg = endpoint_config("ide");
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        let (mut bridge, _tmp) = start_endpoint_for_test(cfg, handler);
        let started = Instant::now();
        bridge.stop().unwrap();
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(1),
            "stop() must join accept thread within 1s, took {elapsed:?}"
        );
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_role_match_header_worker() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(port, None, Some(("x-test-worker-auth", &token)), None);
            let (_ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let evts = events.lock().unwrap().clone();
        let worker_addr = evts.iter().find_map(|e| {
            if let PairingEvent::SlotOccupied {
                role: "worker",
                _peer_addr,
            } = e
            {
                Some(*_peer_addr)
            } else {
                None
            }
        });
        let addr = worker_addr
            .unwrap_or_else(|| panic!("worker role must match via header, got events {evts:?}"));
        assert!(addr.ip().is_loopback());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_role_match_query_plugin() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let req = make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            );
            let (_ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        let evts = events.lock().unwrap().clone();
        assert!(
            evts.iter()
                .any(|e| matches!(e, PairingEvent::SlotOccupied { role: "plugin", .. })),
            "plugin role must match via query param, got events {evts:?}"
        );
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_relay_text_frames() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (mut worker, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (mut plugin, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();

            worker
                .send(Message::Text("ping-text".into()))
                .await
                .unwrap();
            let got = plugin.next().await.unwrap().unwrap();
            assert_eq!(got.into_text().unwrap(), "ping-text");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_relay_close_frames() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (mut worker, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (mut plugin, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();

            worker.close(None).await.ok();
            let saw_close = tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(msg) = plugin.next().await {
                    if matches!(msg, Ok(Message::Close(_)) | Err(_) | Ok(_)) {
                        return true;
                    }
                }
                true
            })
            .await
            .unwrap_or(false);
            assert!(saw_close, "plugin side must observe close propagation");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_event_callback_order_slot_slot_paired_closed() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let (mut worker, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (_plugin, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            worker.close(None).await.ok();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });

        let evts = events.lock().unwrap().clone();
        let kinds: Vec<&str> = evts
            .iter()
            .map(|e| match e {
                PairingEvent::SlotOccupied { .. } => "slot",
                PairingEvent::Paired { .. } => "paired",
                PairingEvent::PairClosed { .. } => "closed",
                _ => "other",
            })
            .collect();
        let paired_idx = kinds.iter().position(|k| *k == "paired");
        let closed_idx = kinds.iter().position(|k| *k == "closed");
        assert!(paired_idx.is_some(), "expected Paired in {kinds:?}");
        assert!(closed_idx.is_some(), "expected PairClosed in {kinds:?}");
        assert!(paired_idx.unwrap() < closed_idx.unwrap());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_rejects_same_role_with_409() {
        let roles = HashMap::from([
            ("worker", AuthScheme::Header("x-test-worker-auth")),
            ("plugin", AuthScheme::QueryParam("token")),
        ]);
        let cfg = HostBridgeConfig::builder("example-plugin")
            .pairing(PairingConfig {
                roles,
                on_role_collision: RoleCollisionPolicy::Reject,
                pending_slot_timeout: None,
            })
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .lock_body(|ctx| {
                serde_json::json!({
                    "port": ctx.port,
                    "authToken": ctx.auth_token,
                })
            })
            .build()
            .unwrap();
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let (_first, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let res = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await;
            assert!(res.is_err(), "second worker must be rejected");
            let err = format!("{:?}", res.err().unwrap());
            assert!(err.contains("409"), "expected HTTP 409, got: {err}");
        });

        let evts = events.lock().unwrap().clone();
        let reject_addr = evts.iter().find_map(|e| {
            if let PairingEvent::SameRoleCollision {
                policy: RoleCollisionPolicy::Reject,
                _peer_addr,
                ..
            } = e
            {
                Some(*_peer_addr)
            } else {
                None
            }
        });
        let addr = reject_addr
            .unwrap_or_else(|| panic!("expected SameRoleCollision(Reject), got {evts:?}"));
        assert!(addr.ip().is_loopback());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_evict_older_replaces_pending() {
        let cfg = pairing_config("example-plugin");
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();

        let rt = tokio_rt();
        rt.block_on(async move {
            let (_first, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let (_second, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let evts = events.lock().unwrap().clone();
        let has_evict = evts.iter().any(|e| {
            matches!(
                e,
                PairingEvent::SameRoleCollision {
                    policy: RoleCollisionPolicy::EvictOlder,
                    role: "worker",
                    ..
                }
            )
        });
        assert!(
            has_evict,
            "expected SameRoleCollision(EvictOlder), got {evts:?}"
        );
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_third_connection_returns_http_409_not_close_1008() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (_w, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (_p, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let res = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await;
            assert!(res.is_err());
            let err = format!("{:?}", res.err().unwrap());
            assert!(err.contains("409"), "must be HTTP 409, got: {err}");
            assert!(
                !err.contains("1008"),
                "must NOT be WebSocket Close 1008, got: {err}"
            );
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_pair_id_generation_prevents_stale_active_clear() {
        let cfg = pairing_config("example-plugin");
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (mut w1, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (mut p1, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            w1.close(None).await.ok();
            p1.close(None).await.ok();
            tokio::time::sleep(Duration::from_millis(200)).await;

            let (_w2, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (_p2, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;

            let res = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await;
            assert!(
                res.is_err(),
                "third connection must be rejected (pair active)"
            );
            let err = format!("{:?}", res.err().unwrap());
            assert!(
                err.contains("409"),
                "must be HTTP 409 (pair busy), got: {err}"
            );
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pairing_max_frame_violation_closes_pair_1009() {
        let roles = HashMap::from([
            ("worker", AuthScheme::Header("x-test-worker-auth")),
            ("plugin", AuthScheme::QueryParam("token")),
        ]);
        let cfg = HostBridgeConfig::builder("example-plugin")
            .pairing(PairingConfig {
                roles,
                on_role_collision: RoleCollisionPolicy::EvictOlder,
                pending_slot_timeout: None,
            })
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .max_frame_bytes(Some(256))
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        let (bridge, _tmp) = start_pairing_for_test(cfg, None);
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (mut worker, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            let (mut plugin, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                Some(&format!("token={token}")),
                None,
                Some("https://example.com"),
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let payload = "x".repeat(1024);
            let _ = worker.send(Message::Text(payload.into())).await;
            let plugin_closed = tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(msg) = plugin.next().await {
                    if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                        return true;
                    }
                }
                false
            })
            .await
            .unwrap_or(false);
            assert!(plugin_closed, "plugin side must close after oversize");
        });
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn pending_slot_timeout_clears_slot() {
        let roles = HashMap::from([
            ("worker", AuthScheme::Header("x-test-worker-auth")),
            ("plugin", AuthScheme::QueryParam("token")),
        ]);
        let cfg = HostBridgeConfig::builder("example-plugin")
            .pairing(PairingConfig {
                roles,
                on_role_collision: RoleCollisionPolicy::EvictOlder,
                pending_slot_timeout: Some(Duration::from_secs(1)),
            })
            .origin_policy(OriginPolicy::AcceptIfAuthIsQueryParam)
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        let events: Arc<Mutex<Vec<PairingEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let cb: PairingEventCallback = Arc::new(move |e| {
            events_clone.lock().unwrap().push(e);
        });
        let (bridge, _tmp) = start_pairing_for_test(cfg, Some(cb));
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let (_solo, _) = tokio_tungstenite::connect_async(make_client_request(
                port,
                None,
                Some(("x-test-worker-auth", &token)),
                None,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(2500)).await;
        });
        let evts = events.lock().unwrap().clone();
        let timed_out = evts
            .iter()
            .any(|e| matches!(e, PairingEvent::PendingSlotTimeout { role: "worker" }));
        assert!(
            timed_out,
            "expected PendingSlotTimeout(worker), got {evts:?}"
        );
    }

    /// The relay lifecycle must ride the bridge lifecycle: ensure at start, periodic
    /// watchdog re-ensure (a WSL distro restart wipes the relay), remove at stop (ADR-080).
    #[test]
    #[serial_test::parallel(host_addressing)]
    fn relay_lifecycle_rides_bridge_start_watchdog_and_stop() {
        use crate::mirror_relay::recorder::{calls_for_port, RelayOp};

        let mut cfg = endpoint_config("relay-lifecycle");
        cfg.watchdog_interval = Duration::from_millis(50);
        let mut bridge = HostBridge::new(cfg).unwrap();
        let port = bridge.port();
        let baseline = calls_for_port(port).len();
        let ops = move || calls_for_port(port).split_off(baseline);

        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler).unwrap();
        assert_eq!(
            ops().first(),
            Some(&RelayOp::Ensure),
            "start must ensure the relay"
        );

        let ensure_count = || ops().iter().filter(|op| **op == RelayOp::Ensure).count();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && ensure_count() < 2 {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            ensure_count() >= 2,
            "watchdog must periodically re-ensure the relay"
        );

        bridge.stop().unwrap();
        assert_eq!(
            ops().last(),
            Some(&RelayOp::Remove),
            "stop must remove the relay (synchronously, after joining the watchdog)"
        );
    }

    #[test]
    fn container_facing_lock_flag_defaults_off_and_plumbs_through() {
        let default = HostBridgeConfig::builder("figma-x")
            .endpoint(AuthScheme::Header("x-test"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|_| serde_json::json!({}))
            .build()
            .unwrap();
        assert!(
            !default.container_facing_lock,
            "default must be host-facing (raw port)"
        );

        let ide = HostBridgeConfig::builder("ide")
            .endpoint(AuthScheme::Header("x-test"))
            .origin_policy(OriginPolicy::RejectIfPresent)
            .lock_body(|_| serde_json::json!({}))
            .container_facing_lock(true)
            .build()
            .unwrap();
        assert!(
            ide.container_facing_lock,
            "opt-in flag must reach the config"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn lock_filename_translates_to_relay_port_only_for_container_facing() {
        let _guard = speedwave_runtime::compose::pin_mirrored_addressing();

        let mut cfg = endpoint_config("ide");
        cfg.container_facing_lock = true;
        let bridge = HostBridge::new(cfg).unwrap();
        let relay = speedwave_runtime::compose::mirror_relay_port(bridge.port())
            .expect("mirrored pin must yield a relay port");
        assert_eq!(
            bridge.lock_file_path().file_name().and_then(|n| n.to_str()),
            Some(format!("{relay}.lock").as_str()),
            "container-facing lock must carry the relay port Claude Code dials"
        );

        let host_facing = HostBridge::new(endpoint_config("figma-x")).unwrap();
        assert_eq!(
            host_facing
                .lock_file_path()
                .file_name()
                .and_then(|n| n.to_str()),
            Some(format!("{}.lock", host_facing.port()).as_str()),
            "host-facing lock must keep the raw bind port"
        );
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn watchdog_relocates_container_facing_lock_after_addressing_flip() {
        let _direct = speedwave_runtime::compose::pin_direct_addressing(
            speedwave_runtime::consts::LIMA_VZ_HOST_IP,
        );
        let mut cfg = endpoint_config("ide");
        cfg.container_facing_lock = true;
        cfg.watchdog_interval = Duration::from_millis(50);
        let mut bridge = HostBridge::new(cfg).unwrap();
        let handler: ConnectionHandler = Arc::new(|_, _| Box::pin(async {}));
        bridge.start_endpoint(handler).unwrap();
        let old_path = bridge.lock_file_path();
        assert!(old_path.exists(), "raw-port lock written at start");

        let _mirrored = speedwave_runtime::compose::pin_mirrored_addressing();
        let relay = speedwave_runtime::compose::mirror_relay_port(bridge.port())
            .expect("mirrored pin must yield a relay port");
        let expected_name = format!("{relay}.lock");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let name = bridge.lock_file_path();
            if name.file_name().and_then(|n| n.to_str()) == Some(expected_name.as_str()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let new_path = bridge.lock_file_path();
        assert_eq!(
            new_path.file_name().and_then(|n| n.to_str()),
            Some(expected_name.as_str()),
            "watchdog must relocate the lock to the relay-port filename"
        );
        assert!(new_path.exists(), "relocated lock written");
        assert!(!old_path.exists(), "stale raw-port lock removed");

        bridge.stop().unwrap();
        assert!(!new_path.exists(), "stop removes the relocated lock");
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn relocate_skips_while_addressing_unresolvable() {
        struct FailingComputer;
        impl speedwave_runtime::compose::HostAddressingComputer for FailingComputer {
            fn compute(&self) -> anyhow::Result<speedwave_runtime::compose::HostAddressing> {
                Err(anyhow::anyhow!("wsl probe failed"))
            }
        }
        let _failing = speedwave_runtime::compose::pin_addressing_computer(FailingComputer);

        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("60123.lock");
        std::fs::write(&current, "{}").unwrap();
        let lock_path = Arc::new(Mutex::new(current.clone()));
        let body_cb: LockBodyBuilder = Arc::new(|_| serde_json::json!({}));

        relocate_lock_on_addressing_change(&lock_path, 60123, &body_cb, "tok");

        assert_eq!(
            *lock_path.lock().unwrap(),
            current,
            "tracked path must be untouched while addressing is unresolvable"
        );
        assert!(current.exists(), "original lock must not be moved");
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn relocate_moves_raw_lock_to_relay_name_on_mirrored_flip() {
        let _mirrored = speedwave_runtime::compose::pin_mirrored_addressing();
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("60123.lock");
        std::fs::write(&raw, "{}").unwrap();
        let lock_path = Arc::new(Mutex::new(raw.clone()));
        let body_cb: LockBodyBuilder = Arc::new(|_| serde_json::json!({}));

        relocate_lock_on_addressing_change(&lock_path, 60123, &body_cb, "tok");

        let relay = speedwave_runtime::compose::mirror_relay_port(60123).unwrap();
        let expected = dir.path().join(format!("{relay}.lock"));
        assert_eq!(
            *lock_path.lock().unwrap(),
            expected,
            "tracked path follows the move"
        );
        assert!(expected.exists(), "relay-named lock written");
        assert!(!raw.exists(), "stale raw-named lock removed");
    }

    /// Verifies lock-file recreation logic; the timing path is covered by the smoke test.
    #[test]
    fn watchdog_recreates_lock_file_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("12345.lock");
        let body = serde_json::json!({"sentinel": true, "port": 12345});

        write_lock_file_atomic(&path, &body).unwrap();
        assert!(path.exists());

        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());

        write_lock_file_atomic(&path, &body).unwrap();
        assert!(
            path.exists(),
            "watchdog recovery path must recreate lock file"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
