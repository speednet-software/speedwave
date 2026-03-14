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
        cost_usd?: number;
        total_cost?: number;
        usage?: UsageInfo;
      };
    }
  | { chunk_type: 'Error'; data: { content: string } };

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

/** A block within a chat message */
export type MessageBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'tool_use'; tool: ToolUseBlock }
  | { type: 'ask_user'; question: AskUserQuestionBlock }
  | { type: 'error'; content: string };

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

/** State for a tool invocation block within a message. */
export interface ToolUseBlock {
  tool_id: string;
  tool_name: string;
  input_json: string;
  result?: string;
  result_is_error?: boolean;
  collapsed: boolean;
  status: 'running' | 'done' | 'error';
}

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

/** Replaces old flat ChatMessage — shared between live chat and transcript */
export interface ChatMessage {
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  timestamp: number;
}

/** Session cost/usage stats */
export interface SessionStats {
  session_id: string;
  cost_usd: number;
  total_cost: number;
  usage?: UsageInfo;
}

/** Response shape for list_projects Tauri command */
export interface ProjectList {
  projects: Array<{ name: string; dir: string }>;
  active_project: string | null;
}

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
