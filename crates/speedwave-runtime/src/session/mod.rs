//! Per-session services that live above the patch backbone (ADRs 042/043/044).
//!
//! - [`queue`] — `QueuedMessageService`, a one-slot queued message store
//!   per session (ADR-045). Replace semantics: typing a new message while
//!   a turn is streaming overwrites the queued slot rather than appending
//!   to a FIFO backlog.
//!
//! No Tauri coupling per `.claude/rules/rust-style.md` — both CLI and
//! Desktop import this module from `speedwave-runtime`.

pub mod queue;

pub use queue::{QueueStats, QueuedMessageService};
