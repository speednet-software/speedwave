//! Conversation state-tree types (ADR-042).
//!
//! [`state_tree`] is the SSOT for the shapes mirrored by the Angular
//! frontend (`models/state-tree.ts`, `models/chat.ts::MessageBlock`) and
//! for the wire types carried by `chat_stream` chunks (AskUser, queue).
//! The JSON-Patch transport that once lived here (MsgStore, patches,
//! entry indices) was retired — see the ADR-042 status note.

pub mod state_tree;

pub use state_tree::{
    AskUserOption, AskUserQuestionItem, ConversationEntry, ConversationState, EntryMeta, EntryRole,
    MessageBlock, QueuedMessage, SessionTotals, TurnUsage, UuidStatus, MAX_ASK_USER_QUESTIONS,
    MAX_ASK_USER_WIRE_BYTES,
};
