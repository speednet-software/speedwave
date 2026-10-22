//! Per-project Desktop relay that exposes host-local HTTP MCP servers to host-mode guards
//! through one bearer-routed `HostBridge` in HttpForward mode. ADR-063, ADR-080.

use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context as _;
use speedwave_runtime::consts;
use speedwave_runtime::custom_mcp::paths;
use speedwave_runtime::fs_perms;

use super::host_bridge::{
    validate_bridge_name, HostBridge, HostBridgeConfig, HostBridgeNewOptions, HttpForwardConfig,
    OriginPolicy, RouteTable, Upstream,
};
use super::http_forward::HOST_LOCAL_UPSTREAM_IP;

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const TOKEN_MIN_LEN: usize = 16;
const TOKEN_MAX_LEN: usize = 512;

/// One host-local server to expose: `name` keys `relay-<name>/`, the upstream is
/// `127.0.0.1:<port><path>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayRoute {
    pub name: String,
    pub port: u16,
    pub path: String,
}

/// The relay of one project: a listener, its route table, and the `relay-<name>/` files
/// (`token`, `endpoint.json`) the host-mode guards read on every request.
pub struct CustomHostRelay {
    routes: RouteTable,
    endpoints: Arc<Mutex<EndpointFiles>>,
    bridge: HostBridge,
}

struct EndpointFiles {
    project_dir: PathBuf,
    names: BTreeSet<String>,
    facing_port: u16,
    available: bool,
}

impl EndpointFiles {
    fn server_dir(&self, name: &str) -> PathBuf {
        self.project_dir.join(paths::relay_dir_name(name))
    }

    fn write_all(&self) -> anyhow::Result<()> {
        let body = serde_json::to_string(&serde_json::json!({
            "url": format!("http://{}:{}/", consts::HOST_GATEWAY_ALIAS, self.facing_port),
            "available": self.available,
        }))?;
        for name in &self.names {
            let path = self
                .server_dir(name)
                .join(consts::CUSTOM_RELAY_ENDPOINT_FILE);
            fs_perms::write_restricted_file(&path, &body)
                .with_context(|| format!("writing {}", path.display()))?;
        }
        Ok(())
    }
}

impl CustomHostRelay {
    /// Binds the relay (preferred port from `relay-port`, else ephemeral) and starts it; the
    /// existing `relay-<name>/endpoint.json` files are rewritten unavailable on the new port.
    pub fn start(data_dir: &Path, project: &str) -> anyhow::Result<Self> {
        Self::start_with(data_dir, project, WATCHDOG_INTERVAL)
    }

    fn start_with(
        data_dir: &Path,
        project: &str,
        watchdog_interval: Duration,
    ) -> anyhow::Result<Self> {
        let state_root = paths::state_root_in(data_dir);
        let project_dir = paths::project_dir_in(data_dir, project)?;
        let lock_dir = paths::relay_lock_dir_in(data_dir, project)?;
        fs_perms::ensure_owner_only_dir(&state_root)
            .with_context(|| format!("creating {}", state_root.display()))?;
        fs_perms::ensure_owner_only_dir(&project_dir)
            .with_context(|| format!("creating {}", project_dir.display()))?;

        let routes: RouteTable = RouteTable::default();
        let endpoints = Arc::new(Mutex::new(EndpointFiles {
            names: existing_server_names(&project_dir),
            project_dir: project_dir.clone(),
            facing_port: 0,
            available: false,
        }));
        let make_config =
            || relay_config(project, &lock_dir, &routes, &endpoints, watchdog_interval);

        crate::firewall::ensure_firewall_rule();
        let port_file = project_dir.join(consts::CUSTOM_RELAY_PORT_FILE);
        let preferred = read_preferred_port(&port_file);
        let mut bridge = match preferred {
            Some(port) => {
                let opts = HostBridgeNewOptions {
                    preferred_port: Some(port),
                    persistent_token_path: None,
                };
                match HostBridge::new_with_options(make_config()?, opts) {
                    Ok(bridge) => bridge,
                    Err(e) => {
                        log::info!(
                            "custom MCP relay of '{project}' cannot reuse port {port} ({e:#}); binding a new one"
                        );
                        HostBridge::new(make_config()?)?
                    }
                }
            }
            None => HostBridge::new(make_config()?)?,
        };
        let port = bridge.port();
        if preferred != Some(port) {
            fs_perms::write_restricted_file(&port_file, &port.to_string())
                .with_context(|| format!("writing {}", port_file.display()))?;
        }
        bridge.start_http_forward()?;

        {
            let mut files = lock_endpoints(&endpoints);
            files.facing_port = speedwave_runtime::compose::container_facing_port(port);
            files.write_all()?;
        }
        log::info!("custom MCP relay of '{project}' listening on port {port}");
        Ok(Self {
            routes,
            endpoints,
            bridge,
        })
    }

    /// Port the relay listens on (host side).
    pub fn port(&self) -> u16 {
        self.bridge.port()
    }

    /// Publishes exactly `routes`: tokens minted or reused, endpoints marked available, the
    /// `relay-<name>/` dirs of servers no longer listed removed. Invalid input changes nothing.
    pub fn set_routes(&mut self, routes: &[RelayRoute]) -> anyhow::Result<()> {
        validate_routes(routes)?;
        let mut files = lock_endpoints(&self.endpoints);
        let mut table = HashMap::with_capacity(routes.len());
        for route in routes {
            let dir = files.server_dir(&route.name);
            fs_perms::ensure_owner_only_dir(&dir)
                .with_context(|| format!("creating {}", dir.display()))?;
            let token = load_or_mint_token(&dir.join(consts::CUSTOM_RELAY_TOKEN_FILE))?;
            table.insert(
                token,
                Upstream {
                    port: route.port,
                    path: route.path.clone(),
                    server: route.name.clone(),
                },
            );
        }
        *self
            .routes
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = table;

        files.names = routes.iter().map(|r| r.name.clone()).collect();
        files.available = true;
        files.write_all()?;
        remove_stale_server_dirs(&files.project_dir, &files.names)
    }

    /// Rewrites every endpoint file with `available:false` (the guard then answers that the
    /// host server needs Speedwave Desktop running).
    pub fn mark_unavailable(&self) -> anyhow::Result<()> {
        let mut files = lock_endpoints(&self.endpoints);
        files.available = false;
        files.write_all()
    }

    /// Stops the listener, removes its lock and mirror relay. Endpoint files stay.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.bridge.stop()
    }

    /// True when something accepts a TCP connection on `127.0.0.1:<port>`; never speaks MCP,
    /// since an `initialize` would open a session in the host app.
    pub fn probe_upstream(port: u16) -> bool {
        if port == 0 {
            return false;
        }
        std::net::TcpStream::connect_timeout(
            &SocketAddr::from((HOST_LOCAL_UPSTREAM_IP, port)),
            PROBE_TIMEOUT,
        )
        .is_ok()
    }
}

fn relay_config(
    project: &str,
    lock_dir: &Path,
    routes: &RouteTable,
    endpoints: &Arc<Mutex<EndpointFiles>>,
    watchdog_interval: Duration,
) -> anyhow::Result<HostBridgeConfig> {
    let lock_project = project.to_string();
    let tick_endpoints = Arc::clone(endpoints);
    let mut config = HostBridgeConfig::builder(consts::CUSTOM_RELAY_BRIDGE_NAME)
        .http_forward(HttpForwardConfig::new(Arc::clone(routes)))
        .origin_policy(OriginPolicy::RejectIfPresent)
        .lock_dir(lock_dir.to_path_buf())
        .lock_body(move |ctx| {
            serde_json::json!({
                "project": lock_project,
                "pid": std::process::id(),
                "port": ctx.port,
            })
        })
        .on_watchdog_tick(move |bind_port| refresh_facing_port(&tick_endpoints, bind_port))
        .build()?;
    config.watchdog_interval = watchdog_interval;
    Ok(config)
}

fn refresh_facing_port(endpoints: &Mutex<EndpointFiles>, bind_port: u16) {
    let facing = speedwave_runtime::compose::container_facing_port(bind_port);
    let mut files = lock_endpoints(endpoints);
    if files.facing_port == facing {
        return;
    }
    let previous = files.facing_port;
    files.facing_port = facing;
    match files.write_all() {
        Ok(()) => log::info!(
            "custom MCP relay endpoints moved from container port {previous} to {facing}"
        ),
        Err(e) => {
            files.facing_port = previous;
            log::warn!("custom MCP relay could not rewrite its endpoints for port {facing}: {e:#}");
        }
    }
}

fn lock_endpoints(endpoints: &Mutex<EndpointFiles>) -> std::sync::MutexGuard<'_, EndpointFiles> {
    endpoints
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn validate_routes(routes: &[RelayRoute]) -> anyhow::Result<()> {
    let mut seen = BTreeSet::new();
    for route in routes {
        if !validate_bridge_name(&route.name)
            || speedwave_runtime::custom_mcp::model::validate_server_name(&route.name).is_err()
        {
            anyhow::bail!("invalid relay server name {:?}", route.name);
        }
        if !seen.insert(route.name.as_str()) {
            anyhow::bail!("relay server {:?} listed twice", route.name);
        }
        if route.port == 0 {
            anyhow::bail!("relay server {:?} has port 0", route.name);
        }
        let path_ok = route.path.starts_with('/')
            && route
                .path
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'?' && b != b'#');
        if !path_ok {
            anyhow::bail!(
                "relay server {:?} has an invalid path {:?}",
                route.name,
                route.path
            );
        }
    }
    Ok(())
}

fn existing_server_names(project_dir: &Path) -> BTreeSet<String> {
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return BTreeSet::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            paths::server_of_relay_dir(e.file_name().to_str()?)
                .filter(|name| validate_bridge_name(name))
                .map(str::to_string)
        })
        .collect()
}

fn remove_stale_server_dirs(project_dir: &Path, keep: &BTreeSet<String>) -> anyhow::Result<()> {
    for name in existing_server_names(project_dir) {
        if keep.contains(&name) {
            continue;
        }
        let dir = project_dir.join(paths::relay_dir_name(&name));
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
    }
    Ok(())
}

fn read_preferred_port(path: &Path) -> Option<u16> {
    std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
}

fn is_valid_token(token: &str) -> bool {
    (TOKEN_MIN_LEN..=TOKEN_MAX_LEN).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_graphic())
}

fn load_or_mint_token(path: &Path) -> anyhow::Result<String> {
    if let Ok(raw) = std::fs::read_to_string(path) {
        let token = raw.trim();
        if is_valid_token(token) {
            return Ok(token.to_string());
        }
        log::warn!(
            "relay token at {} is malformed; minting a new one",
            path.display()
        );
    }
    let token = uuid::Uuid::new_v4().to_string();
    fs_perms::write_restricted_file(path, &token)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(token)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test assertions may unwrap/expect freely"
)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PROJECT: &str = "acme";

    fn route(name: &str, port: u16) -> RelayRoute {
        RelayRoute {
            name: name.to_string(),
            port,
            path: "/mcp".to_string(),
        }
    }

    fn project_dir(data: &Path) -> PathBuf {
        paths::project_dir_in(data, PROJECT).unwrap()
    }

    fn server_dir(data: &Path, name: &str) -> PathBuf {
        paths::relay_dir_in(data, PROJECT, name).unwrap()
    }

    fn endpoint(data: &Path, name: &str) -> serde_json::Value {
        let path = server_dir(data, name).join(consts::CUSTOM_RELAY_ENDPOINT_FILE);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn token(data: &Path, name: &str) -> String {
        std::fs::read_to_string(server_dir(data, name).join(consts::CUSTOM_RELAY_TOKEN_FILE))
            .unwrap()
    }

    fn expected_url(bind_port: u16) -> String {
        format!(
            "http://{}:{}/",
            consts::HOST_GATEWAY_ALIAS,
            speedwave_runtime::compose::container_facing_port(bind_port)
        )
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn start_writes_the_lock_and_port_file_and_stop_removes_the_lock() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        let port = relay.port();
        let lock = paths::relay_lock_dir_in(data.path(), PROJECT)
            .unwrap()
            .join(format!("{port}.{}", consts::CUSTOM_RELAY_LOCK_EXT));
        let body: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&lock).unwrap()).unwrap();
        assert_eq!(body["project"], PROJECT);
        assert_eq!(body["port"], port);
        assert_eq!(body["pid"], std::process::id());
        let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["pid", "port", "project"],
            "the lock never carries the bearer"
        );
        let port_file = project_dir(data.path()).join(consts::CUSTOM_RELAY_PORT_FILE);
        assert_eq!(
            std::fs::read_to_string(&port_file).unwrap(),
            port.to_string()
        );
        #[cfg(unix)]
        {
            assert_eq!(mode(&project_dir(data.path())), 0o700);
            assert_eq!(mode(&port_file), 0o600);
        }
        assert!(
            speedwave_runtime::custom_mcp::relay::is_running_in(data.path(), PROJECT),
            "the CLI reader must find the lock the relay writes"
        );
        relay.stop().unwrap();
        assert!(!lock.exists(), "stop must remove the lock");
        assert!(!speedwave_runtime::custom_mcp::relay::is_running_in(
            data.path(),
            PROJECT
        ));
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn set_routes_publishes_a_token_and_an_available_endpoint() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay.set_routes(&[route("figma", 3845)]).unwrap();

        let ep = endpoint(data.path(), "figma");
        assert_eq!(ep["url"], expected_url(relay.port()));
        assert_eq!(ep["available"], true);
        assert_eq!(ep.as_object().unwrap().len(), 2);
        let url = url::Url::parse(ep["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "http");
        assert!(url.port().is_some());
        assert_eq!(url.path(), "/");

        let tok = token(data.path(), "figma");
        assert!(is_valid_token(&tok), "token {tok:?} must satisfy the guard");
        let table = relay.routes.read().unwrap();
        assert_eq!(
            table.get(&tok),
            Some(&Upstream {
                port: 3845,
                path: "/mcp".into(),
                server: "figma".into()
            })
        );
        #[cfg(unix)]
        {
            let dir = server_dir(data.path(), "figma");
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&dir.join(consts::CUSTOM_RELAY_TOKEN_FILE)), 0o600);
            assert_eq!(mode(&dir.join(consts::CUSTOM_RELAY_ENDPOINT_FILE)), 0o600);
        }
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn tokens_persist_across_restarts_and_a_malformed_one_is_replaced() {
        let data = tempfile::tempdir().unwrap();
        let first = {
            let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
            relay
                .set_routes(&[route("figma", 3845), route("pen", 3846)])
                .unwrap();
            relay.stop().unwrap();
            (token(data.path(), "figma"), token(data.path(), "pen"))
        };
        assert_ne!(first.0, first.1, "each server gets its own bearer");
        let pen_token = server_dir(data.path(), "pen").join(consts::CUSTOM_RELAY_TOKEN_FILE);
        std::fs::write(&pen_token, "short\n").unwrap();

        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay
            .set_routes(&[route("figma", 3845), route("pen", 3846)])
            .unwrap();
        assert_eq!(token(data.path(), "figma"), first.0);
        let replaced = token(data.path(), "pen");
        assert_ne!(replaced, "short\n");
        assert!(is_valid_token(&replaced));
        assert_eq!(relay.routes.read().unwrap().len(), 2);
    }

    #[test]
    fn token_validity_follows_the_guard_contract() {
        assert!(is_valid_token(&"a".repeat(16)));
        assert!(is_valid_token(&"~".repeat(512)));
        assert!(!is_valid_token(&"a".repeat(15)));
        assert!(!is_valid_token(&"a".repeat(513)));
        assert!(!is_valid_token("abcdefgh ijklmnop"));
        assert!(!is_valid_token("abcdefghijklmnopé"));
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn stale_server_dirs_are_removed_and_other_state_kept() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay
            .set_routes(&[route("figma", 3845), route("pen", 3846)])
            .unwrap();
        let orphan = server_dir(data.path(), "gone");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("token"), "x").unwrap();
        let guard_dir = project_dir(data.path()).join("guard");
        std::fs::create_dir_all(&guard_dir).unwrap();

        relay.set_routes(&[route("figma", 3845)]).unwrap();

        assert!(server_dir(data.path(), "figma").is_dir());
        assert!(!server_dir(data.path(), "pen").exists());
        assert!(!orphan.exists());
        assert!(guard_dir.is_dir(), "non-relay state must stay");
        assert!(project_dir(data.path())
            .join(consts::CUSTOM_RELAY_PORT_FILE)
            .is_file());
        assert!(paths::relay_lock_dir_in(data.path(), PROJECT)
            .unwrap()
            .is_dir());
        assert_eq!(relay.routes.read().unwrap().len(), 1);

        relay.set_routes(&[]).unwrap();
        assert!(!server_dir(data.path(), "figma").exists());
        assert!(relay.routes.read().unwrap().is_empty());
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn mark_unavailable_and_set_routes_toggle_availability() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay
            .set_routes(&[route("figma", 3845), route("pen", 3846)])
            .unwrap();
        relay.mark_unavailable().unwrap();
        for name in ["figma", "pen"] {
            let ep = endpoint(data.path(), name);
            assert_eq!(ep["available"], false);
            assert_eq!(ep["url"], expected_url(relay.port()));
        }
        relay.set_routes(&[route("figma", 3845)]).unwrap();
        assert_eq!(endpoint(data.path(), "figma")["available"], true);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn the_preferred_port_is_reused_after_a_restart() {
        for _ in 0..20 {
            let data = tempfile::tempdir().unwrap();
            let mut first = CustomHostRelay::start(data.path(), PROJECT).unwrap();
            let port = first.port();
            first.stop().unwrap();
            drop(first);
            let mut second = CustomHostRelay::start(data.path(), PROJECT).unwrap();
            let reused = second.port() == port;
            second.stop().unwrap();
            if reused {
                return;
            }
        }
        panic!("every freed preferred port was taken again by a parallel test");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn a_busy_preferred_port_falls_back_and_rewrites_the_endpoints() {
        let data = tempfile::tempdir().unwrap();
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy_port = busy.local_addr().unwrap().port();
        let pdir = project_dir(data.path());
        std::fs::create_dir_all(server_dir(data.path(), "figma")).unwrap();
        std::fs::write(
            pdir.join(consts::CUSTOM_RELAY_PORT_FILE),
            busy_port.to_string(),
        )
        .unwrap();
        std::fs::write(
            server_dir(data.path(), "figma").join(consts::CUSTOM_RELAY_ENDPOINT_FILE),
            format!(r#"{{"url":"http://host.docker.internal:{busy_port}/","available":true}}"#),
        )
        .unwrap();

        let relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        assert_ne!(relay.port(), busy_port);
        assert_eq!(
            std::fs::read_to_string(pdir.join(consts::CUSTOM_RELAY_PORT_FILE)).unwrap(),
            relay.port().to_string()
        );
        let ep = endpoint(data.path(), "figma");
        assert_eq!(ep["url"], expected_url(relay.port()));
        assert_eq!(
            ep["available"], false,
            "a restarted relay has no routes until set_routes"
        );
        drop(busy);
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn invalid_routes_change_nothing() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay.set_routes(&[route("figma", 3845)]).unwrap();
        let before = token(data.path(), "figma");
        let bad_sets = [
            vec![route("../etc", 1)],
            vec![route("Figma", 1)],
            vec![route("", 1)],
            vec![route("guard", 1)],
            vec![route("relay-x", 1)],
            vec![route("pen-up", 1)],
            vec![route("pen", 0)],
            vec![route("pen", 1), route("pen", 2)],
            vec![RelayRoute {
                name: "pen".into(),
                port: 1,
                path: "mcp".into(),
            }],
            vec![RelayRoute {
                name: "pen".into(),
                port: 1,
                path: "/mcp?x=1".into(),
            }],
            vec![RelayRoute {
                name: "pen".into(),
                port: 1,
                path: "/m cp".into(),
            }],
        ];
        for routes in bad_sets {
            assert!(relay.set_routes(&routes).is_err(), "{routes:?}");
        }
        assert_eq!(token(data.path(), "figma"), before);
        assert!(!server_dir(data.path(), "pen").exists());
        assert_eq!(endpoint(data.path(), "figma")["available"], true);
        assert_eq!(relay.routes.read().unwrap().len(), 1);
    }

    #[test]
    fn an_invalid_project_name_is_rejected_before_anything_is_written() {
        let data = tempfile::tempdir().unwrap();
        assert!(CustomHostRelay::start(data.path(), "../evil").is_err());
        assert!(CustomHostRelay::start(data.path(), "").is_err());
        assert!(!data.path().join(consts::CUSTOM_MCP_STATE_DIR).exists());
    }

    async fn raw_post(port: u16, bearer: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let req = format!(
            "POST / HTTP/1.1\r\nHost: host.docker.internal\r\nAuthorization: Bearer {bearer}\r\n\
             Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn a_relayed_request_reaches_the_upstream_until_its_route_is_removed() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        let port = relay.port();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let up_port = upstream.local_addr().unwrap().port();
            tokio::spawn(async move {
                while let Ok((mut s, _)) = upstream.accept().await {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let _ = s
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                              Content-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                        )
                        .await;
                }
            });
            relay.set_routes(&[route("figma", up_port)]).unwrap();
            let bearer = token(data.path(), "figma");
            let ok = raw_post(port, &bearer).await;
            assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
            assert!(ok.contains("{\"ok\":true}"), "{ok}");

            relay.set_routes(&[]).unwrap();
            let gone = raw_post(port, &bearer).await;
            assert!(gone.starts_with("HTTP/1.1 401"), "{gone}");
        });
    }

    #[test]
    #[serial_test::serial(host_addressing)]
    fn an_addressing_flip_rewrites_the_endpoint_url_and_the_relay_is_ensured() {
        use crate::mirror_relay::recorder::{calls_for_port, RelayOp};

        let _direct = speedwave_runtime::compose::pin_direct_addressing(
            speedwave_runtime::consts::LIMA_VZ_HOST_IP,
        );
        let data = tempfile::tempdir().unwrap();
        let mut relay =
            CustomHostRelay::start_with(data.path(), PROJECT, Duration::from_millis(50)).unwrap();
        let port = relay.port();
        assert_eq!(calls_for_port(port).first(), Some(&RelayOp::Ensure));
        relay.set_routes(&[route("figma", 3845)]).unwrap();
        assert_eq!(
            endpoint(data.path(), "figma")["url"],
            format!("http://{}:{port}/", consts::HOST_GATEWAY_ALIAS)
        );

        let _mirrored = speedwave_runtime::compose::pin_mirrored_addressing();
        let relay_port = speedwave_runtime::compose::mirror_relay_port(port).unwrap();
        let expected = format!("http://{}:{relay_port}/", consts::HOST_GATEWAY_ALIAS);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline
            && endpoint(data.path(), "figma")["url"] != expected.as_str()
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        let ep = endpoint(data.path(), "figma");
        assert_eq!(ep["url"], expected.as_str());
        assert_eq!(ep["available"], true);
        let ensures = calls_for_port(port)
            .iter()
            .filter(|op| **op == RelayOp::Ensure)
            .count();
        assert!(ensures >= 2, "the watchdog must re-ensure the mirror relay");
        relay.stop().unwrap();
        assert_eq!(calls_for_port(port).last(), Some(&RelayOp::Remove));
    }

    #[test]
    fn probe_upstream_is_a_plain_tcp_connect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let live = listener.local_addr().unwrap().port();
        assert!(CustomHostRelay::probe_upstream(live));
        drop(listener);
        let dead = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(!CustomHostRelay::probe_upstream(dead));
        assert!(!CustomHostRelay::probe_upstream(0));
    }

    #[test]
    fn start_ensures_the_firewall_rule_before_binding() {
        let source = include_str!("custom_host_relay.rs");
        let start = source
            .find("    fn start_with(")
            .expect("start_with must exist");
        let body = &source[start..];
        let body = &body[..body
            .find("\n    pub fn port(")
            .expect("port follows start_with")];
        let firewall = body
            .find("crate::firewall::ensure_firewall_rule();")
            .expect("start_with must ensure the firewall rule");
        let bind = body
            .find("HostBridge::new")
            .expect("start_with must bind through HostBridge");
        assert!(firewall < bind, "firewall rule must precede the bind");
    }

    #[test]
    #[serial_test::parallel(host_addressing)]
    fn exit_cleanup_marks_endpoints_unavailable_and_stops_every_relay() {
        let data = tempfile::tempdir().unwrap();
        let mut relay = CustomHostRelay::start(data.path(), PROJECT).unwrap();
        relay.set_routes(&[route("figma", 3845)]).unwrap();
        let lock = relay.bridge.lock_file_path();
        let relays = crate::reconcile::SharedCustomHostRelays::default();
        relays.lock().unwrap().insert(PROJECT.to_string(), relay);

        crate::reconcile::stop_custom_host_relays(&relays);

        assert!(relays.lock().unwrap().is_empty());
        assert_eq!(endpoint(data.path(), "figma")["available"], false);
        assert!(!lock.exists());
    }
}
