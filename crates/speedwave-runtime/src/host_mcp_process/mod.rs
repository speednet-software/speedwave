//! Shared SSOT infrastructure for host-side Node MCP worker process
//! managers (spawn, port handshake, stdio drain, `lock.json`).

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
#[cfg(test)]
pub(crate) use process::KILL_STALE_LOG_MARKER;
pub use process::{HostMcpProcess, LivenessProbe, SpawnContext, WorkerSpec};
pub use stale::{is_node_process, kill_process};

/// Timeout shared by every drain reader when waiting for the worker's
/// initial `{"port": N}` handshake line.
pub const PORT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
