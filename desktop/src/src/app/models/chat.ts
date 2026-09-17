/** Tagged union matching Rust StreamChunk enum (serde tagged) */
export type StreamChunk =
  | { chunk_type: 'Text'; data: { content: string } }
  | { chunk_type: 'Thinking'; data: { content: string } }
  | { chunk_type: 'ToolStart'; data: { tool_id: string; tool_name: string } }
  | { chunk_type: 'ToolInputDelta'; data: { tool_id: string; partial_json: string } }
  | {
      chunk_type: 'ToolInputComplete';
      data: { tool_id: string; input_json: string };
    }
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
        assistant_uuid?: string;
        turn_usage?: TurnUsage;
        turn_cost?: number;
        model?: string;
        context_usage?: TurnUsage;
      };
    }
  | { chunk_type: 'Error'; data: { content: string } }
  | { chunk_type: 'SystemInit'; data: { model: string; session_id?: string } }
  | {
      chunk_type: 'ControlChip';
      data: { command: string; argument: string; uuid?: string };
    }
  | {
      chunk_type: 'RateLimit';
      data: { status: string; utilization: number | null; resets_at: number | null };
    }
  | {
      chunk_type: 'UserMessageCommit';
      data: { uuid: string };
    }
  | {
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
  | 'api_server_interrupted'
  | 'connection_interrupted'
  | 'response_stalled'
  | 'host_slept'
  | 'generic';

const WATCHDOG_ERROR_NEEDLES: ReadonlyArray<{ needle: string; kind: ErrorBlockKind }> = [
  { needle: 'server error mid-response', kind: 'api_server_interrupted' },
  { needle: 'connection closed mid-response', kind: 'connection_interrupted' },
  { needle: 'connection lost mid-response', kind: 'connection_interrupted' },
  { needle: 'the response stopped arriving', kind: 'response_stalled' },
  { needle: 'your computer went to sleep mid-response', kind: 'host_slept' },
];

/**
 * Classifies a raw error string as a known Claude Code watchdog interruption, by
 * case-insensitive substring. Returns `undefined` for anything else.
 * @param content - Raw error text from the backend.
 */
export function watchdogErrorKind(content: string): ErrorBlockKind | undefined {
  const lower = content.toLowerCase();
  return WATCHDOG_ERROR_NEEDLES.find((entry) => lower.includes(entry.needle))?.kind;
}

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
  | { type: 'chip'; command: string; argument: string }
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
  uuid?: string;
  uuid_status?: UuidStatus;
  meta?: EntryMeta;
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
  total_cost: number | null;
  usage?: UsageInfo;
  context_usage?: TurnUsage;
  model?: string;
  rate_limit?: RateLimitInfo;
  context_window_size: number | null;
  total_output_tokens: number;
}

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
  uuid?: string;
  model?: string;
  usage?: TurnUsage;
}

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
