//! Per-session patch emitter that mirrors `StreamChunk` events into the
//! state-tree patch protocol (ADR-042/043/044).
//!
//! The chat reader thread receives `StreamChunk` events from the parser,
//! emits them on the legacy `chat_stream` Tauri channel for backwards
//! compatibility, AND mirrors each chunk into a `ConversationPatch`
//! pushed to the per-session `MsgStore`. The two paths converge on the
//! same logical state: `chat_stream` events drive legacy bindings,
//! patches drive the new `state()` signal in the frontend.
//!
//! Tool block index mapping: `ToolInputDelta` and `ToolResult` arrive
//! out-of-order with their parent `ToolStart`. The emitter keeps a
//! `tool_id -> (entry_idx, block_idx)` map so deltas land on the right
//! block. The map is keyed by the original tool-use id (Claude's
//! `tool_use_id`) — never reused across sessions.

use std::collections::HashMap;
use std::sync::Arc;

use speedwave_runtime::stream::msg_store::LogMsg;
#[cfg(test)]
use speedwave_runtime::stream::QueuedMessage;
use speedwave_runtime::stream::{
    AskUserOption as PatchAskOption, ConversationEntry, ConversationPatch, EntryIndexProvider,
    EntryMeta, EntryRole, MessageBlock as PatchBlock, MsgStore, SessionTotals,
    TurnUsage as PatchTurnUsage, UuidStatus,
};

use crate::chat::{StreamChunk, TurnUsage as RuntimeTurnUsage};
use crate::subscribe_cmd::MsgStoreRegistry;

/// Per-session patch emitter. One instance lives in the chat reader
/// thread; it buffers patches before the session_id is known and
/// flushes them to the MsgStore once it is.
pub struct PatchEmitter {
    /// Resolved once we see the first Result event with a session_id.
    session_id: Option<String>,
    /// Where patches eventually land. `None` until session_id resolved.
    store: Option<Arc<MsgStore>>,
    /// Allocator for entry indices (per-session).
    indices: Option<EntryIndexProvider>,
    /// Patches emitted before session_id was known.
    pending: Vec<LogMsg>,
    /// Currently-streaming assistant entry index, if any.
    current_assistant: Option<usize>,
    /// Most recently-allocated user entry index (for UUID commits).
    last_user_idx: Option<usize>,
    /// `(entry_idx, block_idx)` for every active tool_use seen so far.
    tool_blocks: HashMap<String, (usize, usize)>,
    /// Mirror of blocks per entry — needed because RFC 6902 has no
    /// "append" op, so we replay the accumulated content for streaming
    /// text/thinking/tool-input deltas.
    blocks_for_entry: HashMap<usize, Vec<PatchBlock>>,
    /// `entry_idx -> block_idx` of the (single) leading text block on
    /// each assistant entry.
    text_block_for_entry: HashMap<usize, usize>,
    /// `entry_idx -> block_idx` of the active thinking block.
    thinking_block_for_entry: HashMap<usize, usize>,
    /// Last known cumulative session totals — kept in lockstep with patches.
    totals: SessionTotals,
    /// Last known model id (from SystemInit or Result.model).
    model: Option<String>,
}

impl Default for PatchEmitter {
    fn default() -> Self {
        Self::new()
    }
}

impl PatchEmitter {
    pub fn new() -> Self {
        Self {
            session_id: None,
            store: None,
            indices: None,
            pending: Vec::new(),
            current_assistant: None,
            last_user_idx: None,
            tool_blocks: HashMap::new(),
            blocks_for_entry: HashMap::new(),
            text_block_for_entry: HashMap::new(),
            thinking_block_for_entry: HashMap::new(),
            totals: SessionTotals::default(),
            model: None,
        }
    }

    /// Rebind to a registry-backed store the first time we know the session id.
    ///
    /// Order matters: the pre-bind queue (`self.pending`) carries patches that
    /// already allocated indices via the local fallback in `next_index()`.
    /// Those indices live in `self.blocks_for_entry` but the entries themselves
    /// have not yet hit the store. The post-bind index provider must therefore
    /// be derived **after** flushing the queue, so `EntryIndexProvider::start_from`
    /// reads the real `max + 1` from the populated store rather than restarting
    /// at 0. Without this, a multi-turn conversation that goes through ADR-045's
    /// queue-drain path allocates Turn 2's first entry at index 0, colliding
    /// with the user entry already committed in Turn 1.
    ///
    /// `registry.get_or_create` is bypassed in favour of `store_for` so we
    /// don't fork an `EntryIndexProvider` against an empty store before the
    /// flush. The stored `SessionStreams.indices` field is no longer
    /// consulted by this caller.
    fn bind_to(&mut self, registry: &MsgStoreRegistry, session_id: &str) {
        if self.store.is_some() {
            return;
        }
        let store = registry.store_for(session_id);
        self.store = Some(store.clone());
        self.session_id = Some(session_id.to_string());
        // Flush pre-bind patches first so `start_from` sees the real history.
        for msg in std::mem::take(&mut self.pending) {
            store.push(msg);
        }
        self.indices = Some(EntryIndexProvider::start_from(&store));
    }

    fn push(&mut self, msg: LogMsg) {
        if let Some(store) = &self.store {
            store.push(msg);
        } else {
            self.pending.push(msg);
        }
    }

    fn next_index(&mut self) -> usize {
        if let Some(provider) = &self.indices {
            return provider.next();
        }
        // Pre-bind path: hand out monotonic indices from local counter.
        // After bind, the registry's provider takes over from where we
        // left off (start_from() reads max+1 from history).
        let idx = self
            .blocks_for_entry
            .keys()
            .max()
            .map(|h| h + 1)
            .unwrap_or(0);
        // Reserve the index by pre-creating an empty block slot so the
        // running max keeps incrementing across allocations.
        self.blocks_for_entry.entry(idx).or_default();
        idx
    }

    /// Returns the current session_id once known.
    #[cfg(test)]
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Mirror a single `StreamChunk` into the patch protocol.
    pub fn handle_chunk(&mut self, chunk: &StreamChunk, registry: &MsgStoreRegistry) {
        match chunk {
            StreamChunk::SystemInit { model } => {
                self.model = Some(model.clone());
            }
            StreamChunk::Text { content } => {
                let assistant = self.ensure_assistant_entry();
                let text_block_idx = self.ensure_text_block(assistant);
                let new_text = self.append_to_text_like_block(assistant, text_block_idx, content);
                self.push(LogMsg::JsonPatch(ConversationPatch::replace_text(
                    assistant,
                    text_block_idx,
                    &new_text,
                )));
                self.set_streaming(true);
            }
            StreamChunk::Thinking { content } => {
                let assistant = self.ensure_assistant_entry();
                let thinking_block_idx = self.ensure_thinking_block(assistant);
                let new_text =
                    self.append_to_text_like_block(assistant, thinking_block_idx, content);
                self.push(LogMsg::JsonPatch(ConversationPatch::replace_text(
                    assistant,
                    thinking_block_idx,
                    &new_text,
                )));
                self.set_streaming(true);
            }
            StreamChunk::ToolStart { tool_id, tool_name } => {
                let assistant = self.ensure_assistant_entry();
                let block = PatchBlock::ToolUse {
                    tool_id: tool_id.clone(),
                    tool_name: tool_name.clone(),
                    input: String::new(),
                    result: None,
                    is_error: false,
                };
                let block_idx = self.append_block(assistant, block);
                self.tool_blocks
                    .insert(tool_id.clone(), (assistant, block_idx));
                self.set_streaming(true);
            }
            StreamChunk::ToolInputDelta {
                tool_id,
                partial_json,
            } => {
                if let Some(&(entry_idx, block_idx)) = self.tool_blocks.get(tool_id) {
                    let new_input = self.append_to_tool_input(entry_idx, block_idx, partial_json);
                    self.push(LogMsg::JsonPatch(ConversationPatch::replace_tool_input(
                        entry_idx, block_idx, &new_input,
                    )));
                }
            }
            StreamChunk::ToolResult {
                tool_id,
                content,
                is_error,
            } => {
                if let Some(&(entry_idx, block_idx)) = self.tool_blocks.get(tool_id) {
                    self.set_tool_result(entry_idx, block_idx, content, *is_error);
                    self.push(LogMsg::JsonPatch(ConversationPatch::replace_tool_result(
                        entry_idx, block_idx, content, *is_error,
                    )));
                }
            }
            StreamChunk::AskUserQuestion {
                tool_id,
                question,
                options,
                header,
                multi_select,
            } => {
                let assistant = self.ensure_assistant_entry();
                let opts: Vec<PatchAskOption> = options
                    .iter()
                    .map(|o| PatchAskOption {
                        label: o.label.clone(),
                        value: o.value.clone(),
                    })
                    .collect();
                let block = PatchBlock::AskUser {
                    tool_id: tool_id.clone(),
                    header: header.clone(),
                    question: question.clone(),
                    options: opts,
                    multi_select: *multi_select,
                    answer: None,
                };
                self.append_block(assistant, block);
                self.set_streaming(true);
            }
            StreamChunk::Error { content } => {
                let assistant = self.ensure_assistant_entry();
                let block = PatchBlock::Error {
                    content: content.clone(),
                };
                self.append_block(assistant, block);
                self.set_streaming(false);
            }
            StreamChunk::Result {
                session_id,
                turn_usage,
                turn_cost,
                model,
                ..
            } => {
                self.bind_to(registry, session_id);
                self.push(LogMsg::SessionStarted {
                    session_id: session_id.clone(),
                });
                self.push(LogMsg::JsonPatch(ConversationPatch::set_session_id(
                    session_id,
                )));
                if let Some(m) = model {
                    self.model = Some(m.clone());
                }
                if let Some(assistant_idx) = self.current_assistant {
                    let meta = EntryMeta {
                        model: self.model.clone(),
                        usage: turn_usage.as_ref().map(turn_usage_to_patch),
                        cost: *turn_cost,
                    };
                    self.push(LogMsg::JsonPatch(ConversationPatch::replace_meta(
                        assistant_idx,
                        meta,
                    )));
                }
                if let Some(usage) = turn_usage {
                    self.totals.input_tokens += usage.input_tokens;
                    self.totals.output_tokens += usage.output_tokens;
                    self.totals.cache_read_tokens += usage.cache_read_tokens;
                    self.totals.cache_write_tokens += usage.cache_write_tokens;
                }
                if let Some(c) = turn_cost {
                    self.totals.cost += c;
                }
                self.totals.turn_count += 1;
                self.push(LogMsg::JsonPatch(
                    ConversationPatch::replace_session_totals(self.totals),
                ));
                self.set_streaming(false);
                // End of turn: clear per-turn state so the next Text starts
                // a fresh assistant entry and the next UserMessageCommit
                // creates a fresh user entry instead of overwriting the
                // previous turn's user UUID.
                self.current_assistant = None;
                self.last_user_idx = None;
                self.tool_blocks.clear();
            }
            StreamChunk::RateLimit { .. } => {
                // Rate limits are surfaced via the legacy channel for now.
            }
            StreamChunk::UserMessageCommit { uuid } => {
                // Latest user prompt is now retry-anchor-eligible. Synthesise
                // a user entry if we haven't already, then commit the UUID.
                let user_idx = self.ensure_user_entry();
                self.push(LogMsg::JsonPatch(ConversationPatch::replace_entry_uuid(
                    user_idx,
                    Some(uuid),
                    UuidStatus::Committed,
                )));
            }
            StreamChunk::QueueDrained { session_id, .. } => {
                self.bind_to(registry, session_id);
                self.push(LogMsg::JsonPatch(ConversationPatch::set_pending_queue(
                    None,
                )));
            }
        }
    }

    /// Emit a patch that pre-creates a queued message slot. Called from
    /// the queue command path.
    #[cfg(test)]
    pub fn handle_queue_set(&mut self, msg: QueuedMessage) {
        self.push(LogMsg::JsonPatch(ConversationPatch::set_pending_queue(
            Some(msg),
        )));
    }

    fn ensure_assistant_entry(&mut self) -> usize {
        if let Some(idx) = self.current_assistant {
            return idx;
        }
        let idx = self.next_index();
        let entry = ConversationEntry {
            index: idx,
            role: EntryRole::Assistant,
            uuid: None,
            uuid_status: UuidStatus::Pending,
            blocks: Vec::new(),
            meta: None,
            edited_at: None,
            timestamp: now_ms(),
        };
        self.push(LogMsg::JsonPatch(ConversationPatch::add_entry(idx, entry)));
        self.current_assistant = Some(idx);
        idx
    }

    fn ensure_user_entry(&mut self) -> usize {
        if let Some(idx) = self.last_user_idx {
            return idx;
        }
        let idx = self.next_index();
        let entry = ConversationEntry {
            index: idx,
            role: EntryRole::User,
            uuid: None,
            uuid_status: UuidStatus::Pending,
            blocks: vec![PatchBlock::Text {
                content: String::new(),
            }],
            meta: None,
            edited_at: None,
            timestamp: now_ms(),
        };
        self.push(LogMsg::JsonPatch(ConversationPatch::add_entry(idx, entry)));
        self.last_user_idx = Some(idx);
        idx
    }

    fn ensure_text_block(&mut self, assistant_idx: usize) -> usize {
        if let Some(&idx) = self.text_block_for_entry.get(&assistant_idx) {
            return idx;
        }
        let block_idx = self.append_block(
            assistant_idx,
            PatchBlock::Text {
                content: String::new(),
            },
        );
        self.text_block_for_entry.insert(assistant_idx, block_idx);
        block_idx
    }

    fn ensure_thinking_block(&mut self, assistant_idx: usize) -> usize {
        if let Some(&idx) = self.thinking_block_for_entry.get(&assistant_idx) {
            return idx;
        }
        let block_idx = self.append_block(
            assistant_idx,
            PatchBlock::Thinking {
                content: String::new(),
            },
        );
        self.thinking_block_for_entry
            .insert(assistant_idx, block_idx);
        block_idx
    }

    fn append_block(&mut self, entry_idx: usize, block: PatchBlock) -> usize {
        let blocks = self.blocks_for_entry.entry(entry_idx).or_default();
        let block_idx = blocks.len();
        blocks.push(block.clone());
        self.push(LogMsg::JsonPatch(ConversationPatch::add_block(
            entry_idx, block_idx, block,
        )));
        block_idx
    }

    fn append_to_text_like_block(
        &mut self,
        entry_idx: usize,
        block_idx: usize,
        delta: &str,
    ) -> String {
        let blocks = self.blocks_for_entry.entry(entry_idx).or_default();
        if let Some(b) = blocks.get_mut(block_idx) {
            match b {
                PatchBlock::Text { content } => {
                    content.push_str(delta);
                    return content.clone();
                }
                PatchBlock::Thinking { content } => {
                    content.push_str(delta);
                    return content.clone();
                }
                _ => {}
            }
        }
        delta.to_string()
    }

    fn append_to_tool_input(&mut self, entry_idx: usize, block_idx: usize, delta: &str) -> String {
        let blocks = self.blocks_for_entry.entry(entry_idx).or_default();
        if let Some(PatchBlock::ToolUse { input, .. }) = blocks.get_mut(block_idx) {
            input.push_str(delta);
            return input.clone();
        }
        delta.to_string()
    }

    fn set_tool_result(
        &mut self,
        entry_idx: usize,
        block_idx: usize,
        content: &str,
        is_error: bool,
    ) {
        let blocks = self.blocks_for_entry.entry(entry_idx).or_default();
        if let Some(PatchBlock::ToolUse {
            result,
            is_error: err,
            ..
        }) = blocks.get_mut(block_idx)
        {
            *result = Some(content.to_string());
            *err = is_error;
        }
    }

    fn set_streaming(&mut self, value: bool) {
        self.push(LogMsg::JsonPatch(ConversationPatch::set_streaming(value)));
    }
}

fn turn_usage_to_patch(u: &RuntimeTurnUsage) -> PatchTurnUsage {
    PatchTurnUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: u.cache_write_tokens,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::chat::{AskUserOption as ChatAskOption, StreamChunk, TurnUsage as ChatTurnUsage};

    fn registry() -> MsgStoreRegistry {
        MsgStoreRegistry::new()
    }

    #[test]
    fn text_chunk_creates_assistant_entry_and_appends() {
        let r = registry();
        let mut e = PatchEmitter::new();
        e.handle_chunk(
            &StreamChunk::Text {
                content: "Hi".into(),
            },
            &r,
        );
        assert_eq!(e.pending.len(), 4);
        // 1: add_entry assistant, 2: add_block text, 3: replace_text, 4: set_streaming
        // Once Result fires we'll bind and flush.
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-1".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: Some(ChatTurnUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                }),
                turn_cost: Some(0.001),
                model: Some("opus-4.7".into()),
            },
            &r,
        );
        assert!(e.session_id().is_some());
        let store = r.store_for("s-1");
        // History should contain the flushed patches plus session lifecycle.
        assert!(store.history_len() >= 4);
        let snapshot = store.snapshot_state();
        assert_eq!(snapshot.session_id.as_deref(), Some("s-1"));
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].role, EntryRole::Assistant);
        match &snapshot.entries[0].blocks[0] {
            PatchBlock::Text { content } => assert_eq!(content, "Hi"),
            other => panic!("expected text, got {other:?}"),
        }
        assert_eq!(snapshot.entries[0].meta.as_ref().unwrap().cost, Some(0.001));
        assert_eq!(snapshot.session_totals.cost, 0.001);
        assert_eq!(snapshot.session_totals.turn_count, 1);
        assert!(!snapshot.is_streaming);
    }

    #[test]
    fn tool_lifecycle_routes_deltas_to_correct_block() {
        let r = registry();
        let mut e = PatchEmitter::new();
        e.handle_chunk(
            &StreamChunk::ToolStart {
                tool_id: "t-1".into(),
                tool_name: "Bash".into(),
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::ToolInputDelta {
                tool_id: "t-1".into(),
                partial_json: "{\"cmd\":".into(),
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::ToolInputDelta {
                tool_id: "t-1".into(),
                partial_json: "\"ls\"}".into(),
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::ToolResult {
                tool_id: "t-1".into(),
                content: "/".into(),
                is_error: false,
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-tool".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: None,
                turn_cost: None,
                model: None,
            },
            &r,
        );
        let snapshot = r.store_for("s-tool").snapshot_state();
        assert_eq!(snapshot.entries.len(), 1);
        let block = &snapshot.entries[0].blocks[0];
        match block {
            PatchBlock::ToolUse {
                tool_name,
                input,
                result,
                is_error,
                ..
            } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(input, "{\"cmd\":\"ls\"}");
                assert_eq!(result.as_deref(), Some("/"));
                assert!(!*is_error);
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn ask_user_chunk_appends_block() {
        let r = registry();
        let mut e = PatchEmitter::new();
        e.handle_chunk(
            &StreamChunk::AskUserQuestion {
                tool_id: "ask-1".into(),
                question: "Continue?".into(),
                options: vec![ChatAskOption {
                    label: "Yes".into(),
                    value: "yes".into(),
                }],
                header: "Confirm".into(),
                multi_select: false,
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-ask".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: None,
                turn_cost: None,
                model: None,
            },
            &r,
        );
        let snapshot = r.store_for("s-ask").snapshot_state();
        match &snapshot.entries[0].blocks[0] {
            PatchBlock::AskUser {
                question, options, ..
            } => {
                assert_eq!(question, "Continue?");
                assert_eq!(options.len(), 1);
            }
            other => panic!("expected AskUser, got {other:?}"),
        }
    }

    #[test]
    fn user_message_commit_creates_user_entry_with_committed_uuid() {
        let r = registry();
        let mut e = PatchEmitter::new();
        e.handle_chunk(&StreamChunk::UserMessageCommit { uuid: "u-1".into() }, &r);
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-uuid".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: None,
                turn_cost: None,
                model: None,
            },
            &r,
        );
        let snapshot = r.store_for("s-uuid").snapshot_state();
        let user = snapshot
            .entries
            .iter()
            .find(|e| e.role == EntryRole::User)
            .expect("user entry should exist");
        assert_eq!(user.uuid.as_deref(), Some("u-1"));
        assert_eq!(user.uuid_status, UuidStatus::Committed);
    }

    #[test]
    fn queue_drained_clears_pending_queue() {
        let r = registry();
        let mut e = PatchEmitter::new();
        e.handle_chunk(
            &StreamChunk::QueueDrained {
                session_id: "s-q".into(),
                text: "next".into(),
            },
            &r,
        );
        let snapshot = r.store_for("s-q").snapshot_state();
        assert!(snapshot.pending_queue.is_none());
    }

    /// Regression guard: in a multi-turn conversation that goes through
    /// ADR-045's queue-drain path the same `PatchEmitter` instance handles
    /// Turn 1 (pre-bind), `Result` (bind + flush), and Turn 2 (post-bind).
    /// Before the bind_to fix the post-bind index provider was forked from
    /// an empty store and started at 0, so Turn 2's first allocation
    /// collided with the user/assistant entries already at index 0/1.
    /// After the fix the provider is derived after the flush, so Turn 2
    /// allocates `max(pre_bind) + 1`.
    #[test]
    fn bind_to_post_bind_indices_continue_after_pre_bind_entries() {
        let r = registry();
        let mut e = PatchEmitter::new();
        // Turn 1 (pre-bind): one user commit + one assistant text chunk.
        e.handle_chunk(
            &StreamChunk::UserMessageCommit {
                uuid: "u-turn1".into(),
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::Text {
                content: "Turn 1 reply".into(),
            },
            &r,
        );
        // Result fires the bind + flush.
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-multi".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: None,
                turn_cost: None,
                model: None,
            },
            &r,
        );
        let after_turn_1 = r.store_for("s-multi").snapshot_state();
        assert_eq!(
            after_turn_1.entries.len(),
            2,
            "turn 1 must commit one user + one assistant entry before turn 2 starts"
        );

        // Turn 2 (post-bind): another user commit + assistant text.
        // If the index provider regressed, both of these would re-allocate
        // index 0 / 1 and clobber turn 1 in-place.
        e.handle_chunk(
            &StreamChunk::UserMessageCommit {
                uuid: "u-turn2".into(),
            },
            &r,
        );
        e.handle_chunk(
            &StreamChunk::Text {
                content: "Turn 2 reply".into(),
            },
            &r,
        );
        let snapshot = r.store_for("s-multi").snapshot_state();
        assert_eq!(
            snapshot.entries.len(),
            4,
            "turn 2 must append two new entries; collision would keep len at 2 \
             (entries: {:?})",
            snapshot.entries.iter().map(|e| &e.role).collect::<Vec<_>>()
        );
        // Turn 1 entries must be preserved intact.
        assert_eq!(snapshot.entries[0].uuid.as_deref(), Some("u-turn1"));
        match &snapshot.entries[1].blocks[0] {
            PatchBlock::Text { content } => assert_eq!(content, "Turn 1 reply"),
            other => panic!("turn 1 assistant block clobbered: {other:?}"),
        }
        // Turn 2 entries must occupy fresh indices.
        assert_eq!(snapshot.entries[2].uuid.as_deref(), Some("u-turn2"));
        match &snapshot.entries[3].blocks[0] {
            PatchBlock::Text { content } => assert_eq!(content, "Turn 2 reply"),
            other => panic!("turn 2 assistant block missing: {other:?}"),
        }
    }

    #[test]
    fn handle_queue_set_emits_pending_queue_patch() {
        let r = registry();
        let mut e = PatchEmitter::new();
        // Bind first so the patch lands in store immediately.
        e.handle_chunk(
            &StreamChunk::Result {
                session_id: "s-set".into(),
                total_cost: None,
                usage: None,
                result_text: None,
                context_window_size: None,
                assistant_uuid: None,
                turn_usage: None,
                turn_cost: None,
                model: None,
            },
            &r,
        );
        e.handle_queue_set(QueuedMessage {
            text: "later".into(),
            queued_at: 7,
        });
        let snapshot = r.store_for("s-set").snapshot_state();
        let q = snapshot.pending_queue.as_ref().expect("slot set");
        assert_eq!(q.text, "later");
        assert_eq!(q.queued_at, 7);
    }
}
