//! Per-session services layered on the state-tree types (ADR-042).
//! [`queue`] — `QueuedMessageService`, a one-slot queued message store
//! per session (ADR-045).

pub mod queue;

pub use queue::{QueueStats, QueuedMessageService};
