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
        question: string;
        options: AskUserOption[];
        header: string;
        multi_select: boolean;
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
      };
    }
  | { chunk_type: 'Error'; data: { content: string } }
  | { chunk_type: 'SystemInit'; data: { model: string } }
  | {
      chunk_type: 'RateLimit';
      data: { status: string; utilization: number | null; resets_at: number | null };
    }
  | {
      /** Commits a retry-anchor UUID onto the most recent user entry (ADR-046). */
      chunk_type: 'UserMessageCommit';
      data: { uuid: string };
    };

/** A single selectable option in an AskUserQuestion prompt. */
export interface AskUserOption {
  label: string;
  value: string;
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
    };

/** State for an interactive AskUserQuestion block within a message. */
export interface AskUserQuestionBlock {
  tool_id: string;
  question: string;
  options: AskUserOption[];
  header: string;
  multi_select: boolean;
  answered: boolean;
  selected_values: string[];
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
  | { kind: 'todo_write'; todos: Array<{ id: string; title: string; status: string }> }
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
   * Retry-anchor UUID (ADR-046). User UUIDs commit immediately; assistant
   * UUIDs stay `Pending` until the matching `Result` event commits them.
   * Absent for legacy transcript messages and for local-LLM turns that
   * omit `message.id` — those entries can't be used as retry targets.
   */
  uuid?: string;
  /** Status of the above UUID. Defaults to `Committed` when `uuid` is set. */
  uuid_status?: UuidStatus;
  /**
   * Epoch-ms timestamp of the most recent retry against this entry. Only
   * set on user entries whose turn has been retried via `retry_last_turn`.
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
  /** Total session cost in USD — estimated from token counts at API pricing. */
  total_cost: number;
  /** Per-step usage from flat result.usage (not cumulative). Use for CTX %. */
  usage?: UsageInfo;
  model?: string;
  rate_limit?: RateLimitInfo;
  context_window_size: number;
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
}
