//! State-tree types for JSON-Patch stream protocol (ADR-042).
//!
//! Defines the conversation state shape that the Angular frontend holds as a
//! signal and updates via `json_patch::Patch` operations. Every type is
//! `serde`-serializable so patches can be applied via `json_patch::patch`.

use serde::{Deserialize, Serialize};

/// Root conversation state held by the UI as a single signal.
///
/// Every Tauri event emitted from Rust is a `json_patch::Patch` applied to a
/// value of this type (see ADR-042). Reducer must stay pure: history replay +
/// patch sequence must converge on the same state regardless of delivery time.
/// Manual `Debug` is implemented below to redact `session_id`; per
/// `.claude/rules/logging.md`, structs containing per-session identifiers
/// must redact them in `Debug` output so accidental `format!("{state:?}")`
/// calls cannot leak them to logs.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct ConversationState {
    /// Claude Code session identifier. `None` before the first `SystemInit`.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Ordered list of conversation entries — indices are stable keys per
    /// ADR-044 (monotonic, never reused).
    #[serde(default)]
    pub entries: Vec<ConversationEntry>,
    /// Rolling session totals. Maintained by the same delta handler that
    /// populates per-entry `meta` so both paths stay consistent.
    #[serde(default)]
    pub session_totals: SessionTotals,
    /// One-slot queued message per session (ADR-045). Wave 5 populates this.
    #[serde(default)]
    pub pending_queue: Option<QueuedMessage>,
    /// Model id surfaced by the latest `SystemInit` event.
    #[serde(default)]
    pub model: Option<String>,
    /// `true` while a turn is being streamed from Claude Code.
    #[serde(default)]
    pub is_streaming: bool,
}

impl std::fmt::Debug for ConversationState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationState")
            .field("session_id", &self.session_id.as_ref().map(|_| "…"))
            .field("entries", &self.entries)
            .field("session_totals", &self.session_totals)
            .field("pending_queue", &self.pending_queue)
            .field("model", &self.model)
            .field("is_streaming", &self.is_streaming)
            .finish()
    }
}

/// One entry in the conversation — user or assistant. Tool uses and errors
/// live inside the entry's `blocks` vector.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConversationEntry {
    /// Stable monotonic index allocated by `EntryIndexProvider` (ADR-044).
    pub index: usize,
    /// Who authored this entry.
    pub role: EntryRole,
    /// Message UUID tracked for native resume (ADR-046). `None` until the
    /// relevant `user`/`assistant` stream-json event is seen.
    #[serde(default)]
    pub uuid: Option<String>,
    /// Whether `uuid` is final (committed on `Result`) or provisional.
    #[serde(default)]
    pub uuid_status: UuidStatus,
    /// Union of block variants — text, thinking, tool_use, ask_user, error.
    #[serde(default)]
    pub blocks: Vec<MessageBlock>,
    /// Optional per-turn metadata for assistant entries (model, usage, cost).
    /// Wave 5 Feature 3 populates this; user entries always have `None`.
    #[serde(default)]
    pub meta: Option<EntryMeta>,
    /// Unix-ms timestamp set when a preceding retry bumped this entry.
    #[serde(default)]
    pub edited_at: Option<u64>,
    /// Unix-ms timestamp of entry creation.
    pub timestamp: u64,
}

/// Conversation role.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryRole {
    /// User-authored message.
    User,
    /// Assistant-authored message.
    Assistant,
}

/// Whether an entry's `uuid` is provisional or final.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum UuidStatus {
    /// Not yet committed — e.g. assistant entry streaming, still to see
    /// a `Result` event.
    #[default]
    Pending,
    /// Final — safe to use as a retry target.
    Committed,
}

/// Per-turn metadata attached to assistant entries (Feature 3 / ADR-042).
///
/// All fields are optional so the frontend degrades gracefully when the
/// stream does not carry usage data (older session resumes, edge cases).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct EntryMeta {
    /// Model id used for this turn (e.g. `claude-opus-4-7-20260501`).
    #[serde(default)]
    pub model: Option<String>,
    /// Token usage for this turn (deltas vs the session snapshot at turn start).
    #[serde(default)]
    pub usage: Option<TurnUsage>,
    /// Cost in USD for this turn. Backend may supply verbatim from
    /// `Result.total_cost_usd`; otherwise frontend `pricing.ts` computes it.
    #[serde(default)]
    pub cost: Option<f64>,
}

/// Per-turn token usage. Missing fields are zeroed, not absent, because the
/// frontend arithmetic needs defined values.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct TurnUsage {
    /// Input tokens consumed this turn.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens generated this turn.
    #[serde(default)]
    pub output_tokens: u64,
    /// Cache-read tokens this turn.
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Cache-write tokens this turn.
    #[serde(default)]
    pub cache_write_tokens: u64,
}

/// Rolling totals for the whole session. Bound by the same handler that
/// emits per-entry `meta` patches so `sum(entries.meta.*) == session_totals`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct SessionTotals {
    /// Cumulative input tokens across the session.
    #[serde(default)]
    pub input_tokens: u64,
    /// Cumulative output tokens across the session.
    #[serde(default)]
    pub output_tokens: u64,
    /// Cumulative cache-read tokens.
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Cumulative cache-write tokens.
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// Cumulative cost in USD.
    #[serde(default)]
    pub cost: f64,
    /// Number of completed turns in this session.
    #[serde(default)]
    pub turn_count: u64,
}

/// One-slot queued message waiting for the active turn to finish (ADR-045).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QueuedMessage {
    /// Full text content (not a preview — the UI derives previews).
    pub text: String,
    /// Unix-ms timestamp the queue slot was last set.
    pub queued_at: u64,
}

/// One block inside a conversation entry. Matches the union shape of the
/// desktop `StreamChunk` event family (`desktop/src-tauri/src/chat.rs`) but
/// represents the aggregated state after delta application — not the event.
///
/// Tagged enum: serde serializes as `{"kind":"Text","content":"..."}` so a
/// JSON Patch can replace a block in-place without a re-typing dance.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageBlock {
    /// Rendered assistant/user text. Markdown preserved verbatim; rendering
    /// happens in the UI. Streaming appends to `content` via `Replace` patches.
    Text {
        /// Current text content (may grow during streaming).
        content: String,
    },
    /// Extended thinking / interleaved thinking content.
    Thinking {
        /// Accumulated thinking content.
        content: String,
    },
    /// Tool invocation. The UI normalizes `kind` to a renderer.
    ToolUse {
        /// Tool-use id from the stream event.
        tool_id: String,
        /// Tool name as reported by Claude (e.g. `Bash`, `Read`).
        tool_name: String,
        /// Current accumulated input JSON (may be partial during streaming).
        #[serde(default)]
        input: String,
        /// Final tool result body when available.
        #[serde(default)]
        result: Option<String>,
        /// `true` when the tool reported an error.
        #[serde(default)]
        is_error: bool,
    },
    /// Interactive question from Claude (the `AskUserQuestion` tool variant).
    AskUser {
        /// Tool-use id from the stream event.
        tool_id: String,
        /// Short header shown above the question.
        header: String,
        /// Full question text.
        question: String,
        /// Available options.
        options: Vec<AskUserOption>,
        /// Whether more than one option can be selected.
        multi_select: bool,
        /// Selected values once the user answered. `None` while pending.
        #[serde(default)]
        answer: Option<Vec<String>>,
    },
    /// Terminal error surfaced as a block (rate_limit, network, etc.).
    Error {
        /// Error payload content suitable for display.
        content: String,
    },
}

/// Single option inside an `AskUser` block.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AskUserOption {
    /// Human-readable label.
    pub label: String,
    /// Value sent back as the answer.
    pub value: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_state_is_empty() {
        let state = ConversationState::default();
        assert!(state.entries.is_empty());
        assert!(state.session_id.is_none());
        assert!(state.pending_queue.is_none());
        assert!(!state.is_streaming);
        assert_eq!(state.session_totals, SessionTotals::default());
    }

    #[test]
    fn conversation_state_roundtrip() {
        let state = ConversationState {
            session_id: Some("sess-1".into()),
            entries: vec![ConversationEntry {
                index: 0,
                role: EntryRole::User,
                uuid: Some("u-1".into()),
                uuid_status: UuidStatus::Committed,
                blocks: vec![MessageBlock::Text {
                    content: "hello".into(),
                }],
                meta: None,
                edited_at: None,
                timestamp: 1,
            }],
            session_totals: SessionTotals {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 5,
                cache_write_tokens: 3,
                cost: 0.012,
                turn_count: 1,
            },
            pending_queue: Some(QueuedMessage {
                text: "queued".into(),
                queued_at: 2,
            }),
            model: Some("opus-4.7".into()),
            is_streaming: false,
        };
        let encoded = serde_json::to_value(&state).unwrap();
        let decoded: ConversationState = serde_json::from_value(encoded).unwrap();
        assert_eq!(state, decoded);
    }

    #[test]
    fn entry_role_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(EntryRole::User).unwrap(),
            json!("user")
        );
        assert_eq!(
            serde_json::to_value(EntryRole::Assistant).unwrap(),
            json!("assistant")
        );
    }

    #[test]
    fn uuid_status_default_is_pending() {
        assert_eq!(UuidStatus::default(), UuidStatus::Pending);
        let v: UuidStatus = serde_json::from_value(json!("committed")).unwrap();
        assert_eq!(v, UuidStatus::Committed);
    }

    #[test]
    fn message_block_tag_roundtrip() {
        let blocks = vec![
            MessageBlock::Text {
                content: "hi".into(),
            },
            MessageBlock::Thinking {
                content: "…".into(),
            },
            MessageBlock::ToolUse {
                tool_id: "t1".into(),
                tool_name: "Bash".into(),
                input: "{\"cmd\":\"ls\"}".into(),
                result: Some("/".into()),
                is_error: false,
            },
            MessageBlock::AskUser {
                tool_id: "q1".into(),
                header: "h".into(),
                question: "q?".into(),
                options: vec![AskUserOption {
                    label: "Yes".into(),
                    value: "yes".into(),
                }],
                multi_select: false,
                answer: None,
            },
            MessageBlock::Error {
                content: "boom".into(),
            },
        ];
        let encoded = serde_json::to_value(&blocks).unwrap();
        let decoded: Vec<MessageBlock> = serde_json::from_value(encoded).unwrap();
        assert_eq!(blocks, decoded);
    }

    #[test]
    fn tool_use_optional_fields_default() {
        let blocks: Vec<MessageBlock> = serde_json::from_value(json!([{
            "kind": "tool_use",
            "tool_id": "t1",
            "tool_name": "Read"
        }]))
        .unwrap();
        match &blocks[0] {
            MessageBlock::ToolUse {
                input,
                result,
                is_error,
                ..
            } => {
                assert!(input.is_empty());
                assert!(result.is_none());
                assert!(!*is_error);
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn turn_usage_missing_fields_default_to_zero() {
        let usage: TurnUsage = serde_json::from_value(json!({})).unwrap();
        assert_eq!(usage, TurnUsage::default());
    }

    #[test]
    fn session_totals_roundtrip_with_fractional_cost() {
        let totals = SessionTotals {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            cost: 1.2345,
            turn_count: 7,
        };
        let encoded = serde_json::to_value(totals).unwrap();
        let decoded: SessionTotals = serde_json::from_value(encoded).unwrap();
        assert_eq!(totals, decoded);
    }

    #[test]
    fn queued_message_roundtrip() {
        let q = QueuedMessage {
            text: "next".into(),
            queued_at: 42,
        };
        let encoded = serde_json::to_value(&q).unwrap();
        let decoded: QueuedMessage = serde_json::from_value(encoded).unwrap();
        assert_eq!(q, decoded);
    }

    #[test]
    fn entry_meta_defaults_are_none() {
        let meta = EntryMeta::default();
        assert!(meta.model.is_none());
        assert!(meta.usage.is_none());
        assert!(meta.cost.is_none());
    }

    /// `Debug` for `ConversationState` must redact `session_id` so
    /// accidental `format!("{state:?}")` (e.g. from `dbg!`, `panic!`, or
    /// `tracing::debug!`) cannot leak the per-session identifier. Per
    /// `.claude/rules/logging.md`, structs carrying per-session identifiers
    /// must redact them in `Debug` output. Other diagnostic fields stay
    /// visible — only the identifier is hidden.
    #[test]
    fn debug_redacts_session_id() {
        let state = ConversationState {
            session_id: Some("secret-uuid".into()),
            entries: vec![ConversationEntry {
                index: 0,
                role: EntryRole::User,
                uuid: None,
                uuid_status: UuidStatus::Pending,
                blocks: vec![MessageBlock::Text {
                    content: "diagnostic-text".into(),
                }],
                meta: None,
                edited_at: None,
                timestamp: 1,
            }],
            model: Some("opus-4.7".into()),
            is_streaming: true,
            ..Default::default()
        };
        let dbg = format!("{state:?}");
        assert!(
            !dbg.contains("secret-uuid"),
            "session_id leaked through Debug: {dbg}"
        );
        assert!(
            dbg.contains('…'),
            "expected redaction marker for session_id, got: {dbg}"
        );
        // Non-secret diagnostic fields must still be visible.
        assert!(
            dbg.contains("diagnostic-text"),
            "expected entry text in Debug, got: {dbg}"
        );
        assert!(
            dbg.contains("opus-4.7"),
            "expected model in Debug, got: {dbg}"
        );
        assert!(
            dbg.contains("is_streaming"),
            "expected struct field name in Debug, got: {dbg}"
        );
    }

    /// When `session_id` is `None`, the redaction marker must not appear —
    /// the redaction maps `Some(_) -> Some("…")` and `None -> None` so
    /// the absence of an identifier is honestly reported.
    #[test]
    fn debug_session_id_none_renders_as_none() {
        let state = ConversationState::default();
        let dbg = format!("{state:?}");
        assert!(
            dbg.contains("session_id: None"),
            "expected None for absent session_id, got: {dbg}"
        );
        assert!(
            !dbg.contains('…'),
            "redaction marker leaked when no session_id present: {dbg}"
        );
    }

    #[test]
    fn entry_defaults_for_unicode_content() {
        let entry = ConversationEntry {
            index: 0,
            role: EntryRole::User,
            uuid: None,
            uuid_status: UuidStatus::Pending,
            blocks: vec![MessageBlock::Text {
                content: "héllo 🌊".into(),
            }],
            meta: None,
            edited_at: None,
            timestamp: 0,
        };
        let encoded = serde_json::to_string(&entry).unwrap();
        let decoded: ConversationEntry = serde_json::from_str(&encoded).unwrap();
        assert_eq!(entry, decoded);
    }
}
