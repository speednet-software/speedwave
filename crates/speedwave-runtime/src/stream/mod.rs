//! Conversation state-tree types (ADR-042). [`state_tree`] is the SSOT for shapes mirrored by
//! the Angular frontend and `chat_stream` wire types; the old JSON-Patch transport was retired.

pub mod state_tree;

pub use state_tree::{
    AskUserOption, AskUserQuestionItem, ConversationEntry, ConversationState, EntryMeta, EntryRole,
    MessageBlock, QueuedMessage, SessionTotals, TurnUsage, UuidStatus, MAX_ASK_USER_QUESTIONS,
    MAX_ASK_USER_WIRE_BYTES,
};
