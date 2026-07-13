//! Plugin host bridge — generic Desktop wrapper that builds a `HostBridge` from a plugin
//! manifest's `host_bridge` declaration (roles, env-vars, origin/collision policy, frame cap).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use speedwave_runtime::plugin::{
    HostBridgeCollisionPolicy, HostBridgeManifest, HostBridgeOriginPolicy, HostBridgeRoleAuth,
};

use super::host_bridge::{
    AuthScheme, HostBridge, HostBridgeConfig, HostBridgeNewOptions, OriginPolicy, PairingConfig,
    PairingEvent, PairingEventCallback, RoleCollisionPolicy, SubprotocolPolicy,
};

const DEFAULT_PENDING_SLOT_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;
// SSOT lives in `speedwave_runtime::plugin`; re-exported so existing call
// sites keep resolving `plugin_host_bridge::BRIDGE_TOKEN_FILENAME`.
pub use speedwave_runtime::plugin::BRIDGE_TOKEN_FILENAME;

/// Lock-file payload written under `~/.speedwave/<slug>-bridge/<port>.lock`.
#[derive(Serialize)]
struct PluginBridgeLockFile {
    pid: u32,
    port: u16,
    #[serde(rename = "ideName")]
    ide_name: String,
    transport: &'static str,
    #[serde(rename = "authToken")]
    auth_token: String,
}

/// Generic pairing events surfaced to the Desktop UI. Serialized form is the SSOT for the
/// `plugin_bridge_event` Tauri event; mirror `BridgeEventPayload` in `plugin-bridge.service.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginBridgeEvent {
    SlotOccupied { role: String },
    Paired { roles: Vec<String> },
    Disconnected { reason: String },
    PairBusy,
    EvictedOlder { role: String },
    PendingTimeout { role: String },
}

pub type PluginBridgeEventCallback = Arc<dyn Fn(PluginBridgeEvent) + Send + Sync + 'static>;

/// Plugin-UI credentials (loopback URL + shared token). No Debug: carries the bearer token.
#[derive(Clone)]
pub struct PluginBridgeCredentials {
    pub local_ui_url: String,
    pub token: String,
}

/// Raw bridge facts the compose layer combines with the env-var
/// names declared in the plugin manifest. No Debug: carries the bearer token.
#[derive(Clone)]
pub struct PluginBridgeComposeInfo {
    pub port: u16,
    pub auth_token: String,
}

pub struct PluginHostBridge {
    manifest: HostBridgeManifest,
    inner: HostBridge,
    event_cb: Arc<Mutex<Option<PluginBridgeEventCallback>>>,
    paired: Arc<std::sync::atomic::AtomicBool>,
    partner_connected: Arc<std::sync::atomic::AtomicBool>,
}

impl PluginHostBridge {
    pub fn new(slug: &str, manifest: HostBridgeManifest) -> anyhow::Result<Self> {
        if manifest.roles.is_empty() {
            anyhow::bail!("plugin '{slug}': host_bridge.roles must not be empty");
        }
        let roles = translate_roles(&manifest.roles);
        let origin_policy = translate_origin_policy(&manifest.origin_policy);
        let collision_policy = translate_collision_policy(&manifest.collision_policy);
        let pending_slot_timeout = manifest
            .pending_slot_timeout_secs
            .map(Duration::from_secs)
            .or(Some(DEFAULT_PENDING_SLOT_TIMEOUT));
        let max_frame_bytes = manifest.max_frame_bytes.or(Some(DEFAULT_MAX_FRAME_BYTES));
        let display_name = manifest.display_name.clone();

        let config = HostBridgeConfig::builder(slug)
            .pairing(PairingConfig {
                roles,
                on_role_collision: collision_policy,
                pending_slot_timeout,
            })
            .origin_policy(origin_policy)
            .subprotocol(SubprotocolPolicy { accepted: &[] })
            .max_frame_bytes(max_frame_bytes)
            .lock_body(move |ctx| {
                let lock = PluginBridgeLockFile {
                    pid: std::process::id(),
                    port: ctx.port,
                    ide_name: display_name.clone(),
                    transport: "ws",
                    auth_token: ctx.auth_token.to_string(),
                };
                serde_json::to_value(&lock).unwrap_or(serde_json::Value::Null)
            })
            .build()?;

        let opts = HostBridgeNewOptions {
            preferred_port: manifest.preferred_port,
            persistent_token_path: manifest.persistent_token.then(|| {
                speedwave_runtime::plugin::plugin_state_dir(slug).join(BRIDGE_TOKEN_FILENAME)
            }),
        };
        Ok(Self {
            manifest,
            inner: HostBridge::new_with_options(config, opts)?,
            event_cb: Arc::new(Mutex::new(None)),
            paired: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            partner_connected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    pub fn manifest(&self) -> &HostBridgeManifest {
        &self.manifest
    }

    pub fn port(&self) -> u16 {
        self.inner.port()
    }

    pub fn auth_token(&self) -> String {
        self.inner.auth_token()
    }

    pub fn is_paired(&self) -> bool {
        self.paired.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn has_partner(&self) -> bool {
        self.partner_connected
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn set_event_callback(&mut self, cb: PluginBridgeEventCallback) {
        if let Ok(mut guard) = self.event_cb.lock() {
            *guard = Some(cb);
        }
    }

    pub fn start(&mut self) -> anyhow::Result<()> {
        let event_cb = self.event_cb.clone();
        let paired = self.paired.clone();
        let partner = self.partner_connected.clone();
        let pairing_cb: PairingEventCallback = Arc::new(move |evt| {
            if let Some(translated) = translate_pairing_event(evt) {
                match &translated {
                    PluginBridgeEvent::SlotOccupied { .. } => {
                        partner.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    PluginBridgeEvent::Paired { .. } => {
                        partner.store(true, std::sync::atomic::Ordering::Relaxed);
                        paired.store(true, std::sync::atomic::Ordering::Release);
                    }
                    PluginBridgeEvent::Disconnected { .. } => {
                        paired.store(false, std::sync::atomic::Ordering::Release);
                        partner.store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    _ => {}
                }
                if let Ok(guard) = event_cb.lock() {
                    if let Some(cb) = guard.as_ref() {
                        cb(translated);
                    }
                }
            }
        });
        self.inner.start_pairing(Some(pairing_cb))
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.paired
            .store(false, std::sync::atomic::Ordering::Release);
        self.partner_connected
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.inner.stop()
    }

    pub fn compose_info(&self) -> PluginBridgeComposeInfo {
        PluginBridgeComposeInfo {
            port: self.port(),
            auth_token: self.auth_token(),
        }
    }

    pub fn credentials_for_local_ui(&self) -> PluginBridgeCredentials {
        PluginBridgeCredentials {
            local_ui_url: format!("ws://127.0.0.1:{}/", self.port()),
            token: self.auth_token(),
        }
    }
}

impl Drop for PluginHostBridge {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

/// Intern table: each unique string leaks once, reused across respawns.
static STRING_INTERN: std::sync::Mutex<Option<HashMap<String, &'static str>>> =
    std::sync::Mutex::new(None);

fn intern_static(s: &str) -> &'static str {
    match STRING_INTERN.lock() {
        Ok(mut guard) => {
            let table = guard.get_or_insert_with(HashMap::new);
            if let Some(&existing) = table.get(s) {
                return existing;
            }
            let leaked: &'static str = Box::leak(s.to_string().into_boxed_str());
            table.insert(s.to_string(), leaked);
            leaked
        }
        Err(e) => {
            log::warn!("string intern table poisoned ({e}); leaking uncached");
            Box::leak(s.to_string().into_boxed_str())
        }
    }
}

fn translate_roles(
    manifest_roles: &HashMap<String, HostBridgeRoleAuth>,
) -> HashMap<&'static str, AuthScheme> {
    let mut out = HashMap::with_capacity(manifest_roles.len());
    for (role_name, auth) in manifest_roles {
        let role_static = intern_static(role_name);
        let scheme = match auth {
            HostBridgeRoleAuth::Header { name } => AuthScheme::Header(intern_static(name)),
            HostBridgeRoleAuth::QueryParam { name } => AuthScheme::QueryParam(intern_static(name)),
        };
        out.insert(role_static, scheme);
    }
    out
}

fn translate_origin_policy(p: &HostBridgeOriginPolicy) -> OriginPolicy {
    match p {
        HostBridgeOriginPolicy::RejectIfPresent => OriginPolicy::RejectIfPresent,
        HostBridgeOriginPolicy::AcceptIfAuthIsQueryParam => OriginPolicy::AcceptIfAuthIsQueryParam,
    }
}

fn translate_collision_policy(p: &HostBridgeCollisionPolicy) -> RoleCollisionPolicy {
    match p {
        HostBridgeCollisionPolicy::Reject => RoleCollisionPolicy::Reject,
        HostBridgeCollisionPolicy::EvictOlder => RoleCollisionPolicy::EvictOlder,
    }
}

fn translate_pairing_event(evt: PairingEvent) -> Option<PluginBridgeEvent> {
    match evt {
        PairingEvent::SlotOccupied { role, .. } => Some(PluginBridgeEvent::SlotOccupied {
            role: role.to_string(),
        }),
        PairingEvent::Paired { roles } => Some(PluginBridgeEvent::Paired {
            roles: roles.into_iter().map(str::to_string).collect(),
        }),
        PairingEvent::PairClosed { reason } => Some(PluginBridgeEvent::Disconnected { reason }),
        PairingEvent::PairBusy { .. } => Some(PluginBridgeEvent::PairBusy),
        PairingEvent::SameRoleCollision { role, policy, .. } => match policy {
            RoleCollisionPolicy::EvictOlder => Some(PluginBridgeEvent::EvictedOlder {
                role: role.to_string(),
            }),
            RoleCollisionPolicy::Reject => Some(PluginBridgeEvent::PairBusy),
        },
        PairingEvent::PendingSlotTimeout { role } => Some(PluginBridgeEvent::PendingTimeout {
            role: role.to_string(),
        }),
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, reason = "test module")]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use speedwave_runtime::plugin::HostBridgeRoleAuth;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    fn fixture_manifest() -> HostBridgeManifest {
        let mut roles = HashMap::new();
        roles.insert(
            "worker".to_string(),
            HostBridgeRoleAuth::Header {
                name: "x-test-worker-auth".to_string(),
            },
        );
        roles.insert(
            "plugin".to_string(),
            HostBridgeRoleAuth::QueryParam {
                name: "token".to_string(),
            },
        );
        HostBridgeManifest {
            url_env: "TEST_BRIDGE_URL".into(),
            token_env: "TEST_BRIDGE_TOKEN".into(),
            roles,
            origin_policy: HostBridgeOriginPolicy::AcceptIfAuthIsQueryParam,
            max_frame_bytes: Some(1024 * 1024),
            collision_policy: HostBridgeCollisionPolicy::EvictOlder,
            pending_slot_timeout_secs: Some(60),
            display_name: "Test Bridge".into(),
            preferred_port: None,
            persistent_token: false,
        }
    }

    fn start_bridge() -> (PluginHostBridge, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let mut bridge = PluginHostBridge::new("testplugin", fixture_manifest()).unwrap();
        bridge.start().unwrap();
        (bridge, tmp)
    }

    fn tokio_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn new_rejects_empty_roles() {
        let mut m = fixture_manifest();
        m.roles.clear();
        let err = PluginHostBridge::new("x", m).err().unwrap().to_string();
        assert!(err.contains("roles must not be empty"));
    }

    #[test]
    fn manifest_drives_role_auth_schemes() {
        let (bridge, _tmp) = start_bridge();
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let url = format!("ws://127.0.0.1:{port}/");
            let mut req = url.into_client_request().unwrap();
            req.headers_mut().insert(
                "x-test-worker-auth",
                http::HeaderValue::from_str(&token).unwrap(),
            );
            let (_w, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        });
    }

    #[test]
    fn manifest_drives_relay_between_two_roles() {
        let (bridge, _tmp) = start_bridge();
        let port = bridge.port();
        let token = bridge.auth_token();
        let rt = tokio_rt();
        rt.block_on(async move {
            let worker_url = format!("ws://127.0.0.1:{port}/");
            let mut worker_req = worker_url.into_client_request().unwrap();
            worker_req.headers_mut().insert(
                "x-test-worker-auth",
                http::HeaderValue::from_str(&token).unwrap(),
            );
            let plugin_url = format!("ws://127.0.0.1:{port}/?token={token}");
            let mut plugin_req = plugin_url.into_client_request().unwrap();
            plugin_req
                .headers_mut()
                .insert("origin", http::HeaderValue::from_static("https://x.test"));

            let (mut worker, _) = tokio_tungstenite::connect_async(worker_req).await.unwrap();
            let (mut plugin, _) = tokio_tungstenite::connect_async(plugin_req).await.unwrap();

            worker.send(Message::Text("hello".into())).await.unwrap();
            let got = plugin.next().await.unwrap().unwrap();
            assert_eq!(got.into_text().unwrap(), "hello");
        });
    }

    #[test]
    fn compose_info_returns_port_and_token() {
        let (bridge, _tmp) = start_bridge();
        let info = bridge.compose_info();
        assert_eq!(info.port, bridge.port());
        assert_eq!(info.auth_token, bridge.auth_token());
    }

    #[test]
    fn credentials_for_local_ui_uses_loopback() {
        let (bridge, _tmp) = start_bridge();
        let creds = bridge.credentials_for_local_ui();
        assert!(creds.local_ui_url.starts_with("ws://127.0.0.1:"));
        assert_eq!(creds.token, bridge.auth_token());
    }

    #[test]
    fn lock_file_uses_display_name_from_manifest() {
        let (bridge, _tmp) = start_bridge();
        let body: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(bridge.inner.lock_file_path()).unwrap())
                .unwrap();
        assert_eq!(body["ideName"], "Test Bridge");
        assert_eq!(body["transport"], "ws");
    }
}
