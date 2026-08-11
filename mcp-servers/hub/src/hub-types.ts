/** Hub-specific types (executor, skills); PII types live in \@speedwave/policy-engine; base types from \@speedwave/mcp-shared */

// ── Code Executor Types ───────────────────────────────────────────────────────────────────────

/**
 * Tool execution error
 */
export interface IToolError {
  /** Error code identifier */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
  /** Whether the operation can be retried */
  retryable: boolean;
}

/**
 * Standard tool result interface
 * All tool files return this shape for consistency
 */
export interface IToolResult<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Result data if successful */
  data?: T;
  /** Error information if failed */
  error?: IToolError;
  /** Execution metadata */
  metadata?: {
    /** ISO timestamp of execution */
    timestamp: string;
    /** Execution time in milliseconds */
    executionMs: number;
    /** Service that handled the request */
    service: string;
    /** Syntax warning from auto-return transformation (set when code has parse errors) */
    warning?: string;
  };
}

/**
 * Token provider interface for dependency injection
 */
export interface ITokenProvider {
  /** Get authentication token for a service. */
  getToken(service: string): Promise<string>;
}

/**
 * Logger interface for dependency injection
 */
export interface ILogger {
  /** Log info message */
  info(message: string, data?: unknown): void;
  /** Log warning message */
  warn(message: string, data?: unknown): void;
  /** Log error message */
  error(message: string, error: unknown): void;
  /** Log debug message */
  debug(message: string, data?: unknown): void;
}

/**
 * Tool execution context
 * Passed to tool functions for access to session, tokens, logging
 */
export interface IToolContext {
  /** Current session ID */
  sessionId: string;
  /** Optional project ID */
  projectId?: string;
  /** Optional user ID */
  userId?: string;
  /** Token provider for accessing service tokens */
  tokens: ITokenProvider;
  /** Logger instance */
  logger: ILogger;
}

// ── Tool Discovery Types (Progressive Disclosure) ─────────────────────────────────────────────

/**
 * Tool input example (Tool Use Examples pattern).
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */
export interface ToolInputExample {
  /** Description of the example: "Minimal", "Partial", "Full" */
  description: string;
  /** Actual input parameters for this example */
  input: Record<string, unknown>;
}

/** Timeout class: 'standard' (default, EXECUTION_MS) or 'long' (slow ops, LONG_OPERATION_MS). */
export type TimeoutClass = 'standard' | 'long';

/**
 * Tool file metadata (for progressive disclosure)
 */
export interface ToolMetadata {
  /** Tool name as exposed by the hub (camelCase, used by JS bridge API). */
  name: string;
  /** Tool name as exposed by the worker (often snake_case); falls back to `name` if absent. */
  workerToolName?: string;
  /** Tool description */
  description: string;
  /** Search keywords */
  keywords: string[];
  /** JSON schema for input parameters */
  inputSchema: Record<string, unknown>;
  /** Output schema describing the structure of tool response (Anthropic Advanced Tool Use) */
  outputSchema?: Record<string, unknown>;
  /** Usage example */
  example: string;
  /** Multiple examples showing minimal/partial/full usage patterns */
  inputExamples?: ToolInputExample[];
  /** Service this tool belongs to */
  service: string;
  /** Defer loading: true = on-demand discovery, false = always loaded (core tool) */
  deferLoading?: boolean;
  /** Timeout class: 'standard' (default) or 'long' for slow operations */
  timeoutClass?: TimeoutClass;
  /** Custom timeout in milliseconds for long-running operations (overrides WORKER_REQUEST_MS) */
  timeoutMs?: number;
  /** OS sub-integration category (only for os service): 'reminders', 'calendar', 'mail', 'notes' */
  osCategory?: 'reminders' | 'calendar' | 'mail' | 'notes';
  /** Behavioral annotations from the worker (readOnlyHint, destructiveHint, etc.) */
  annotations?: import('@speedwave/mcp-shared').ToolAnnotations;
  /** True when results depend on the authenticated user's identity. */
  userScoped?: boolean;
  /** Name of the sibling tool that resolves "me"/"my" without an explicit id param. */
  currentUserTool?: string;
  /** Name of the input param that accepts a self-referential value (e.g. "me"). */
  selfParam?: string;
}

/**
 * Tool search result (progressive disclosure levels)
 */
export interface ToolSearchResult {
  /** Tool name */
  tool: string;
  /** Service name */
  service: string;
  /** Tool description (included with with_descriptions level) */
  description?: string;
  /** Input schema (included with full_schema level) */
  inputSchema?: Record<string, unknown>;
  /** Output schema describing the structure of tool response (Anthropic Advanced Tool Use) */
  outputSchema?: Record<string, unknown>;
  /** Usage example (included with full_schema level) */
  example?: string;
  /** Multiple examples (returned with full_schema detail level) */
  inputExamples?: ToolInputExample[];
  /** Defer loading status: true = on-demand, false = core tool */
  deferLoading?: boolean;
  /** Self-reference sentence for userScoped tools; present at every detail level. */
  identityHint?: string;
}
