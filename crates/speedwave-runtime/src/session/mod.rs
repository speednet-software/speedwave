//! Per-session services layered on the state-tree types (ADR-042).
//! [`queue`] — `QueuedMessageService`, a one-slot queued message store
//! per session (ADR-045).

pub mod cli_lock;
pub mod instance;
pub mod queue;

pub use cli_lock::{any_cli_session_active, CliSessionGuard};
pub use instance::{
    instance_env_argv, kill_by_instance_command, new_instance_id, SESSION_INSTANCE_ENV,
};
pub use queue::{QueueStats, QueuedMessageService};
