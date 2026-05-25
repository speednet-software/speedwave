//! Host-side WebSocket bridges connecting in-container workers to host-side
//! applications. `host_bridge` is the generic skeleton (TCP listener, lock
//! file, auth, lifecycle); `plugin_host_bridge` builds one for any plugin
//! whose manifest declares a `host_bridge` block; `ide_bridge` is the Claude
//! Code IDE proxy.

pub mod host_bridge;
pub mod ide_bridge;
pub mod plugin_bridge_manager;
pub mod plugin_host_bridge;
