//! Host-side WebSocket bridges connecting in-container workers to host apps:
//! `host_bridge` (generic skeleton), `plugin_host_bridge` (per-plugin),
//! `ide_bridge` (Claude Code IDE proxy).

pub mod host_bridge;
pub mod ide_bridge;
pub mod plugin_bridge_manager;
pub mod plugin_host_bridge;
