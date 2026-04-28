/**
 * State-tree types mirroring `crates/speedwave-runtime/src/stream/state_tree.rs`.
 *
 * The Rust side serialises these via serde with `rename_all = "snake_case"`
 * for tagged enums and default field names otherwise. Keeping the TS shapes
 * verbatim means JSON Patches produced in Rust apply to these objects on
 * the wire without a translation step.
 * @see docs/adr/ADR-042-json-patch-stream-protocol.md
 */

/** Conversation role. */
export type EntryRole = 'user' | 'assistant';

/** Whether an entry's `uuid` is provisional or final. */
export type UuidStatus = 'pending' | 'committed';

/** Per-turn token usage. Cache fields are required (zero when missing). */
export interface TurnUsageState {
  /** Input tokens this turn. */
  input_tokens: number;
  /** Output tokens this turn. */
  output_tokens: number;
  /** Cache-read tokens this turn. */
  cache_read_tokens: number;
  /** Cache-write tokens this turn. */
  cache_write_tokens: number;
}

/** Rolling totals for the whole session. */
export interface SessionTotalsState {
  /** Cumulative input tokens. */
  input_tokens: number;
  /** Cumulative output tokens. */
  output_tokens: number;
  /** Cumulative cache-read tokens. */
  cache_read_tokens: number;
  /** Cumulative cache-write tokens. */
  cache_write_tokens: number;
  /** Cumulative cost in USD. */
  cost: number;
  /** Number of completed turns in this session. */
  turn_count: number;
}

/** One-slot queued message (ADR-045). */
export interface QueuedMessageState {
  /** Full text content (not a preview — the UI derives previews). */
  text: string;
  /** Unix-ms timestamp the queue slot was last set. */
  queued_at: number;
}

/** Optional per-turn metadata attached to assistant entries. */
export interface EntryMetaState {
  /** Model id used for this turn (e.g. `claude-opus-4-7`). */
  model?: string;
  /** Per-turn token usage. */
  usage?: TurnUsageState;
  /** Per-turn cost in USD. */
  cost?: number;
}

/**
 * One block inside a conversation entry. Tagged enum: serde serializes as
 * `{"kind":"text","content":"..."}` — preserving that shape lets a JSON
 * Patch replace a block in-place without a re-typing dance.
 */
export type MessageBlockState =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | {
      kind: 'tool_use';
      tool_id: string;
      tool_name: string;
      input: string;
      result: string | null;
      is_error: boolean;
    }
  | {
      kind: 'ask_user';
      tool_id: string;
      header: string;
      question: string;
      options: ReadonlyArray<{ label: string; value: string }>;
      multi_select: boolean;
      answer: ReadonlyArray<string> | null;
    }
  | { kind: 'error'; content: string };

/** One entry in the conversation — user or assistant. */
export interface ConversationEntryState {
  /** Stable monotonic index allocated by `EntryIndexProvider` (ADR-044). */
  index: number;
  /** Who authored this entry. */
  role: EntryRole;
  /** Message UUID tracked for native resume (ADR-046). */
  uuid: string | null;
  /** Whether `uuid` is final (committed on `Result`) or provisional. */
  uuid_status: UuidStatus;
  /** Block contents — text, thinking, tool_use, ask_user, error. */
  blocks: MessageBlockState[];
  /** Optional per-turn metadata for assistant entries. */
  meta: EntryMetaState | null;
  /** Unix-ms timestamp set when a preceding retry bumped this entry. */
  edited_at: number | null;
  /** Unix-ms timestamp of entry creation. */
  timestamp: number;
}

/** Root conversation state held by the UI as a single signal. */
export interface ConversationStateTree {
  /** Claude Code session identifier. `null` before the first `SystemInit`. */
  session_id: string | null;
  /** Ordered list of conversation entries. */
  entries: ConversationEntryState[];
  /** Rolling session totals — kept consistent with per-entry meta. */
  session_totals: SessionTotalsState;
  /** One-slot queued message per session (ADR-045). */
  pending_queue: QueuedMessageState | null;
  /** Model id surfaced by the latest `SystemInit` event. */
  model: string | null;
  /** True while a turn is being streamed from Claude Code. */
  is_streaming: boolean;
}

/** The default state-tree at app startup — mirrors `ConversationState::default()`. */
export const DEFAULT_STATE_TREE: ConversationStateTree = {
  session_id: null,
  entries: [],
  session_totals: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
    turn_count: 0,
  },
  pending_queue: null,
  model: null,
  is_streaming: false,
};

/**
 * Wire-shape of one event emitted by `MsgStore.history_plus_stream()`.
 * Tagged-enum representation matches `LogMsg` in
 * `crates/speedwave-runtime/src/stream/msg_store.rs`.
 */
export type LogMsgEnvelope =
  | { type: 'json_patch'; data: unknown }
  | { type: 'resync'; data: ConversationStateTree }
  | { type: 'session_started'; data: { session_id: string } }
  | { type: 'session_ended'; data?: never };
