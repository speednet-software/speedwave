//! Shared infrastructure for host-side Node MCP worker process managers.
//!
//! Three host-side workers (mcp-os, host_exec, oauth) all spawn a Node
//! child, read a `{"port": N}` handshake line, drain stdout/stderr to a
//! log file, write port/pid/auth-token to disk, and detect/kill stale
//! processes from prior sessions. This module hosts the SSOT pieces of
//! that pattern; per-worker modules consume them through `pub use`.
//!
//! PR1 of the consolidation (see plan in `.claude/plans/`) extracts only
//! the helpers — `HostMcpProcess<S: WorkerSpec>` and unified lock-file
//! format follow in PR2/PR3.

pub mod drain;
pub mod env_policy;
pub mod probe;
pub mod stale;

pub use drain::{drain_and_read_port, parse_port_line};
pub use env_policy::{apply_child_env, CurrentProcessEnv, EnvSource, WINDOWS_SYSTEM_ENV_VARS};
pub use probe::{is_pid_alive, probe_tcp};
pub use stale::{is_node_process, kill_process, kill_stale_by_pid_file};

/// Timeout shared by every drain reader when waiting for the worker's
/// initial `{"port": N}` line. 10 s is long enough for Node + V8 startup
/// on Windows under cold cache; short enough that a hung worker fails
/// loudly instead of stalling the host indefinitely.
pub const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
