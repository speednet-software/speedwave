/**
 * Hub-Specific Types
 * @module hub-types
 *
 * Extended types for mcp-hub (code executor, PII tokenization, skills)
 * Base MCP types are imported from \@speedwave/mcp-shared
 */

//═══════════════════════════════════════════════════════════════════════════════
// Code Executor Types
//═══════════════════════════════════════════════════════════════════════════════

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
  };
}

/**
 * Token provider interface for dependency injection
 */
export interface ITokenProvider {
  /**
   * Get authentication token for a service
   * @param service - Service name
   * @returns Authentication token
   */
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

//═══════════════════════════════════════════════════════════════════════════════
// Tool Discovery Types (Progressive Disclosure)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Tool input example (for Tool Use Examples pattern)
 * Based on: Anthropic "Advanced Tool Use" article
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */
export interface ToolInputExample {
  /** Description of the example: "Minimal", "Partial", "Full" */
  description: string;
  /** Actual input parameters for this example */
  input: Record<string, unknown>;
}

/**
 * Timeout class for operations - used to determine execution timeout
 * - standard: Normal operations (default) - uses EXECUTION_MS
 * - long: Long-running operations (sync, extract, AI generation) - uses LONG_OPERATION_MS
 */
export type TimeoutClass = 'standard' | 'long';

/**
 * Tool file metadata (for progressive disclosure)
 */
export interface ToolMetadata {
  /** Tool name */
  name: string;
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
}

//═══════════════════════════════════════════════════════════════════════════════
// PII Tokenization Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * PII Token entry
 */
export interface PIITokenEntry {
  /** Token string (e.g., "[EMAIL:TOKEN_A1B2C3]") */
  token: string;
  /** Type of PII */
  type: PIIType;
  /** Original sensitive value */
  value: string;
  /** When this token was created */
  createdAt: Date;
  /** Number of times this token has been accessed */
  accessCount: number;
  /** Last time this token was accessed */
  lastAccessed?: Date;
}

/**
 * PII Types supported for tokenization
 */
export enum PIIType {
  EMAIL = 'EMAIL',
  PHONE_PL = 'PHONE_PL',
  PESEL = 'PESEL',
  NIP = 'NIP',
  IBAN = 'IBAN',
  CARD = 'CARD',
  API_KEY = 'API_KEY',
  /** Sensitive field detected by key name (password, token, secret, etc.) */
  SENSITIVE_FIELD = 'SENSITIVE_FIELD',
}
