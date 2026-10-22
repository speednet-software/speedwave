//! Host-side bridges to host apps: `host_bridge` (generic skeleton), `http_forward` (its HTTP
//! mode), `plugin_host_bridge` (per-plugin), `ide_bridge` (IDE proxy), `custom_host_relay`.

pub mod custom_host_relay;
pub mod host_bridge;
pub mod http_forward;
pub mod ide_bridge;
pub mod plugin_bridge_manager;
pub mod plugin_host_bridge;
