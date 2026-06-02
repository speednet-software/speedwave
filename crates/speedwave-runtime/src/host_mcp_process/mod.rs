//! Shared infrastructure for host-side Node MCP worker process managers.
//!
//! Three workers (mcp-os, host_exec, oauth) all spawn a Node child,
//! read a `{"port": N}` handshake on stdout, drain stdio into an audit
//! log, and persist `lock.json` for compose injection. This module
//! holds the SSOT pieces:
//!
//! - `drain` — stdout/stderr drain + handshake.
//! - `env_policy` — `env_clear()` + minimal re-add, `EnvSource` trait
//!   so tests inject `FakeEnv` instead of mutating `std::env`.
//! - `lock` — unified `lock.json` schema + idempotent migration from
//!   the legacy three-file layout (`port` + `pid` + `auth-token`).
//! - `probe` — `is_pid_alive` + `probe_tcp` with retry/backoff.
//! - `stale` — kill confirmed-node stale PIDs left by prior sessions.
//! - `process` — generic [`HostMcpProcess<S: WorkerSpec>`] all three
//!   per-worker managers use as a type alias.

pub mod drain;
pub mod env_policy;
pub(crate) mod job_object;
pub mod lock;
pub mod probe;
pub mod process;
pub mod stale;

pub use drain::{drain_and_read_port, parse_port_line};
pub use env_policy::{apply_child_env, CurrentProcessEnv, EnvSource, WINDOWS_SYSTEM_ENV_VARS};
#[cfg(test)]
pub use lock::migrate_legacy;
pub use lock::{
    migrate_legacy_with_target, read as read_lock, write as write_lock, LockFile, LockService,
};
pub use probe::{is_pid_alive, probe_tcp};
pub use process::{HostMcpProcess, LivenessProbe, SpawnContext, WorkerSpec, KILL_STALE_LOG_MARKER};
pub use stale::{is_node_process, kill_process};

/// Timeout shared by every drain reader when waiting for the worker's
/// initial `{"port": N}` line. 10 s is long enough for Node + V8 startup
/// on Windows under cold cache; short enough that a hung worker fails
/// loudly instead of stalling the host indefinitely.
pub const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
