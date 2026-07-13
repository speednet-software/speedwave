/** Tagged union matching Rust StreamChunk enum (serde tagged) */
export type StreamChunk =
  | { chunk_type: 'Text'; data: { content: string } }
  | { chunk_type: 'Thinking'; data: { content: string } }
  | { chunk_type: 'ToolStart'; data: { tool_id: string; tool_name: string } }
  | { chunk_type: 'ToolInputDelta'; data: { tool_id: string; partial_json: string } }
  | { chunk_type: 'ToolResult'; data: { tool_id: string; content: string; is_error: boolean } }
  | {
      chunk_type: 'AskUserQuestion';
      data: {
        tool_id: string;
        questions: AskUserQuestionItem[];
        current_index: number;
      };
    }
  | {
      chunk_type: 'Result';
      data: {
        session_id: string;
        total_cost?: number;
        usage?: UsageInfo;
        result_text?: string;
        context_window_size?: number;
        /** UUID of the assistant message that just completed (ADR-046). */
        assistant_uuid?: string;
        /** Per-turn token usage delta (since the last Result). */
        turn_usage?: TurnUsage;
        /** Per-turn cost in USD — prefers CLI's authoritative total_cost_usd delta when available. */
        turn_cost?: number;
        /** Model name for this turn, if known at emission time. */
        model?: string;
        /** Usage of the most recent main-chain API call — the context-occupancy source. */
        context_usage?: TurnUsage;
      };
    }
  | { chunk_type: 'Error'; data: { content: string } }
  | { chunk_type: 'SystemInit'; data: { model: string; session_id?: string } }
  | {
      chunk_type: 'RateLimit';
      data: { status: string; utilization: number | null; resets_at: number | null };
    }
  | {
      /** Commits a retry-anchor UUID onto the most recent user entry (ADR-046). */
      chunk_type: 'UserMessageCommit';
      data: { uuid: string };
    }
  | {
      /**
       * One-slot queued message (ADR-045) was drained server-side after the previous turn ended.
       * Frontend clears `pendingQueue` on receipt — the queued payload is already in flight via stdin.
       */
      chunk_type: 'QueueDrained';
      data: { session_id: string; text: string };
    };

/** A single selectable option in an AskUserQuestion prompt. */
export interface AskUserOption {
  label: string;
  value: string;
}

/**
 * One question inside an AskUserQuestion control_request — mirrors `crate::chat::AskUserQuestionItem`
 * (`speedwave_runtime::stream::AskUserQuestionItem`). Up to 4/chunk; empty array tolerated, dropped host-side.
 */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserOption[];
  multi_select: boolean;
}

/** Token usage breakdown for a streaming session. */
export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/**
 * Optional discriminator for error-block visual variants. `undefined` (or any
 * unknown value) renders as the generic red-timeline variant.
 */
export type ErrorBlockKind =
  | 'rate_limit'
  | 'network'
  | 'session_exited'
  | 'broken_pipe'
  | 'no_active_project'
  | 'session_starting'
  | 'auth_required'
  | 'stopped_by_user'
  | 'generic';

/**
 * Per-turn token usage. Unlike `UsageInfo`, all cache fields are required
 * numbers (missing values are normalized to 0 by the backend).
 */
export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * Context-window occupancy from one API call: input-only (fresh + cached + cache-written),
 * matching Claude Code's own `used_percentage` formula.
 * @param u - per-call usage from the last main-chain API response
 */
export function contextTokensFrom(u: TurnUsage): number {
  return u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
}

/**
 * Per-turn metadata for an assistant message: model, token usage, and cost. Populated from `Result`
 * chunks. Missing fields hide their corresponding rendered segment, not the whole row.
 */
export interface EntryMeta {
  model?: string;
  usage?: TurnUsage;
  cost?: number;
}

/**
 * One-slot queued message (ADR-045). Mirrors the Rust `QueuedMessage` type; the composer surfaces
 * `text` as the "queued: …" preview and exposes a cancel button that drops the slot via `cancel_queued_message`.
 */
export interface QueuedMessage {
  text: string;
  queued_at: number;
}

/** A block within a chat message */
export type MessageBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'tool_use'; tool: ToolUseBlock }
  | { type: 'ask_user'; question: AskUserQuestionBlock }
  | { type: 'error'; content: string; kind?: ErrorBlockKind }
  | {
      type: 'permission_prompt';
      command: string;
      description?: string;
      decided?: 'allow_once' | 'allow_always' | 'deny';
    }
  /** Image placeholder; bytes live on disk (ADR-065). */
  | { type: 'image'; media_type: string; alt?: string };

/**
 * State for an interactive AskUserQuestion block: up to 4 questions; renderer shows only
 * `questions[current_index]`, prior indices show `answers[i]`; done when `current_index === questions.length`.
 */
export interface AskUserQuestionBlock {
  tool_id: string;
  questions: AskUserQuestionItem[];
  current_index: number;
  answers: (string | null)[];
}

/** State for a tool invocation block within a message (discriminated union on status). */
export type ToolUseBlock =
  | {
      type: 'tool_use';
      tool_id: string;
      tool_name: string;
      input_json: string;
      status: 'running';
    }
  | {
      type: 'tool_use';
      tool_id: string;
      tool_name: string;
      input_json: string;
      status: 'done';
      result: string;
      result_is_error: false;
    }
  | {
      type: 'tool_use';
      tool_id: string;
      tool_name: string;
      input_json: string;
      status: 'error';
      result: string;
      result_is_error: true;
    };

/** Normalized tool input for display */
export type NormalizedToolInput =
  | { kind: 'bash'; command: string }
  | { kind: 'read'; file_path: string; offset?: number; limit?: number }
  | { kind: 'write'; file_path: string; content: string }
  | { kind: 'edit'; file_path: string; old_string: string; new_string: string }
  | { kind: 'glob'; pattern: string; path?: string }
  | { kind: 'grep'; pattern: string; path?: string; include?: string }
  | {
      kind: 'todo_write';
      todos: Array<{ content: string; status: string; activeForm?: string }>;
    }
  | { kind: 'web_search'; query: string }
  | { kind: 'web_fetch'; url: string }
  | { kind: 'agent'; description: string }
  | { kind: 'generic'; raw_json: string };

/** Retry-anchor UUID commit state for a ChatMessage (ADR-046). */
export type UuidStatus = 'Pending' | 'Committed';

/** Replaces old flat ChatMessage — shared between live chat and transcript */
export interface ChatMessage {
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  timestamp: number;
  /**
   * Retry-anchor UUID (ADR-046). User UUIDs commit immediately; assistant UUIDs stay `Pending` until
   * the matching `Result` commits them. Absent for legacy transcripts and local-LLM turns lacking `message.id`.
   */
  uuid?: string;
  /** Status of the above UUID. Defaults to `Committed` when `uuid` is set. */
  uuid_status?: UuidStatus;
  /**
   * Per-turn metadata (assistant messages only — undefined for user messages).
   * Populated from the `Result` chunk that terminated the turn.
   */
  meta?: EntryMeta;
  /**
   * Epoch-ms timestamp of the most recent retry against this entry, set via `retry_last_turn`;
   * surfaces as `· edited` in the metadata line of the assistant that follows.
   */
  edited_at?: number;
}

/** Rate limit info from rate_limit_event. */
export interface RateLimitInfo {
  status: string;
  utilization: number;
  resets_at: number | null;
}

/** Session cost/usage stats */
export interface SessionStats {
  session_id: string;
  /** Project cost in USD from the proxy SSOT; `null` when unpriced (subscription) → "—". */
  total_cost: number | null;
  /**
   * Per-turn sums from flat result.usage (every API call added together) — feeds `in:`/`out:` counters,
   * NEVER context occupancy: cache reads repeat per call, exceeding the window on tool-use turns.
   */
  usage?: UsageInfo;
  /**
   * Usage of the most recent main-chain API call; `contextTokensFrom` of it
   * is the context-window occupancy that drives the CTX meter.
   */
  context_usage?: TurnUsage;
  model?: string;
  rate_limit?: RateLimitInfo;
  /**
   * Context window in tokens; `null` for local providers when discovery couldn't determine a value
   * (ADR-041 "never guess"). UI hides the `used / max` ratio rather than fabricating a default.
   */
  context_window_size: number | null;
  /** Cumulative output tokens across all turns in the session. */
  total_output_tokens: number;
}

// ProjectList and ProjectEntry are defined in models/update.ts (SSOT)
export type { ProjectList, ProjectEntry } from './update';

/** A summary of a past conversation returned by list_conversations. */
export interface ConversationSummary {
  session_id: string;
  timestamp: string | null;
  preview: string;
  message_count: number;
}

/** Full transcript of a past conversation returned by get_conversation. */
export interface ConversationTranscript {
  session_id: string;
  messages: ConversationMessage[];
}

/** A single message within a conversation transcript. */
export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string | null;
  blocks?: MessageBlock[];
  /**
   * Stable JSONL uuid that anchors the retry-last-turn flow (ADR-046); `undefined` for synthesized
   * entries (e.g. `result` lines) — those never become a retry target.
   */
  uuid?: string;
  /** Per-message model id (assistant turns only); restores the resumed footer. */
  model?: string;
  /** Per-message token usage (assistant turns only). */
  usage?: TurnUsage;
}

// Wire types — mirror `chat.rs::WireContentBlock` (ADR-065).

/** Text segment of a wire user message. */
export interface WireTextBlock {
  type: 'text';
  text: string;
}

/** One content block crossing the wire to Claude. */
export type WireContentBlock = WireTextBlock;

/** Image attachment persisted to `<project>/.speedwave/pastes/`. */
export interface ChatAttachment {
  filename: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** `/workspace/...` path Claude sees. */
  containerPath: string;
  hostPath: string;
}

/** Composer-collected user input bundled with image attachments. */
export interface ChatInput {
  text: string;
  attachments: ChatAttachment[];
}

/**
 * Wraps a plain string into a text-only `ChatInput`.
 * @param text - Raw user text.
 */
export function chatInputFromText(text: string): ChatInput {
  return { text, attachments: [] };
}

/**
 * Serializes a `ChatInput` into wire content blocks, inlining attachments as `@…` refs.
 * @param input - Composer input bundle.
 */
export function chatInputToBlocks(input: ChatInput): WireContentBlock[] {
  const lines: string[] = [];
  if (input.text.length > 0) {
    lines.push(input.text);
  }
  for (const att of input.attachments) {
    lines.push(`@${att.containerPath}`);
  }
  if (lines.length === 0) {
    return [];
  }
  const joiner = input.text.length > 0 && input.attachments.length > 0 ? '\n\n' : '\n';
  return [{ type: 'text', text: lines.join(joiner) }];
}
