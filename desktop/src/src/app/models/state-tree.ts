/** Conversation role. */
export type EntryRole = 'user' | 'assistant';

/** Whether an entry's `uuid` is provisional or final. */
export type UuidStatus = 'pending' | 'committed';

/** Per-turn token usage. Cache fields are required (zero when missing). */
export interface TurnUsageState {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Rolling totals for the whole session. */
export interface SessionTotalsState {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  turn_count: number;
}

/** One-slot queued message (ADR-045). */
export interface QueuedMessageState {
  text: string;
  queued_at: number;
}

/** Optional per-turn metadata attached to assistant entries. */
export interface EntryMetaState {
  model?: string;
  usage?: TurnUsageState;
  cost?: number;
}

import type { AskUserQuestionItem } from './chat';

/**
 * One question inside an `ask_user` block; mirrors Rust `AskUserQuestionItem` (SSOT in `models/chat.ts`).
 */
export type AskUserQuestionStateItem = Readonly<AskUserQuestionItem>;

/**
 * One block inside a conversation entry. Tagged union mirroring the Rust
 * `MessageBlock` serde shape (`{"kind":"text","content":"..."}`).
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
      questions: ReadonlyArray<AskUserQuestionStateItem>;
      current_index: number;
      answers: ReadonlyArray<string | null>;
    }
  | { kind: 'error'; content: string }
  | { kind: 'image'; media_type: string; alt: string | null }
  | { kind: 'chip'; command: string; argument: string };

/** One entry in the conversation — user or assistant. */
export interface ConversationEntryState {
  index: number;
  role: EntryRole;
  uuid: string | null;
  uuid_status: UuidStatus;
  blocks: MessageBlockState[];
  meta: EntryMetaState | null;
  edited_at: number | null;
  timestamp: number;
}

/** Root conversation state held by the UI as a single signal. */
export interface ConversationStateTree {
  session_id: string | null;
  entries: ConversationEntryState[];
  session_totals: SessionTotalsState;
  pending_queue: QueuedMessageState | null;
  model: string | null;
  is_streaming: boolean;
}

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
