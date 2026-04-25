//! JSON-Patch stream protocol backbone (ADRs 042 / 043 / 044).
//!
//! This module is the SSOT for the Rust side of the Tauri event contract:
//!
//! - [`state_tree`] — `ConversationState` and its child types, the single
//!   state-tree shape held by the Angular frontend as a signal.
//! - [`patch`] — `ConversationPatch` typed helpers and the `apply` reducer.
//!   All mutations flow through this module so the state-shape change
//!   surface is auditable.
//! - [`msg_store`] — per-session broadcast + bounded-history store with a
//!   100 MB replay cap.
//! - [`entry_index`] — atomic counter producing the stable entry indices
//!   used as UI keys and JSON-Patch path segments.
//!
//! Downstream units (Wave 5 Features 2 / 3 and the Tauri bridge) consume
//! this module; it has no Tauri coupling per `.claude/rules/rust-style.md`.

pub mod entry_index;
pub mod msg_store;
pub mod patch;
pub mod state_tree;

pub use entry_index::EntryIndexProvider;
pub use msg_store::{LogMsg, MsgStore, DEFAULT_HISTORY_BYTES};
pub use patch::{apply, ConversationPatch};
pub use state_tree::{
    AskUserOption, ConversationEntry, ConversationState, EntryMeta, EntryRole, MessageBlock,
    QueuedMessage, SessionTotals, TurnUsage, UuidStatus,
};
