//! Per-session services layered on the state-tree types (ADR-042).
//! [`queue`] — `QueuedMessageService`, a one-slot queued message store
//! per session (ADR-045).

pub mod instance;
pub mod queue;

pub use instance::{instance_env_argv, kill_by_instance_command, SESSION_INSTANCE_ENV};
pub use queue::{QueueStats, QueuedMessageService};
