/**
 * MCP Protocol TypeScript Types
 * Based on: Model Context Protocol Specification 2025-11-25
 *
 * Security: Strongly typed to prevent injection attacks
 */

//═══════════════════════════════════════════════════════════════════════════════
// JSON-RPC 2.0 Base Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * JSON-RPC 2.0 request message structure.
 * Used for communication between MCP client and server.
 * @interface JSONRPCRequest
 * @see https://www.jsonrpc.org/specification
 */
export interface JSONRPCRequest {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Unique request identifier used to correlate responses */
  id: string | number;
  /** Method name to invoke on the server */
  method: string;
  /** Optional parameters for the method */
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 notification message structure.
 * Notifications are like requests but do not expect a response.
 * @interface JSONRPCNotification
 * @see https://www.jsonrpc.org/specification
 */
export interface JSONRPCNotification {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Method name to invoke on the server */
  method: string;
  /** Optional parameters for the method */
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response message structure.
 * Sent by server in response to a request. Contains either result or error.
 * @interface JSONRPCResponse
 * @see https://www.jsonrpc.org/specification
 */
export interface JSONRPCResponse {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Request ID that this response correlates to (null for errors before parsing ID) */
  id: string | number | null;
  /** Result data if the request succeeded */
  result?: unknown;
  /** Error information if the request failed */
  error?: JSONRPCError;
}

/**
 * JSON-RPC 2.0 error object structure.
 * Provides standardized error information in responses.
 * @interface JSONRPCError
 * @see https://www.jsonrpc.org/specification#error_object
 */
export interface JSONRPCError {
  /** Error code as defined in JSON-RPC spec or custom codes */
  code: number;
  /** Human-readable error message */
  message: string;
  /** Optional additional error details */
  data?: unknown;
}

/**
 * Standard JSON-RPC 2.0 error codes and custom extensions.
 * Negative codes from -32768 to -32000 are reserved by JSON-RPC spec.
 * @enum {number}
 * @see https://www.jsonrpc.org/specification#error_object
 */
export enum JSONRPCErrorCode {
  /** Invalid JSON was received by the server (-32700) */
  ParseError = -32700,
  /** The JSON sent is not a valid Request object (-32600) */
  InvalidRequest = -32600,
  /** The method does not exist or is not available (-32601) */
  MethodNotFound = -32601,
  /** Invalid method parameter(s) (-32602) */
  InvalidParams = -32602,
  /** Internal JSON-RPC error (-32603) */
  InternalError = -32603,
  /** Custom: Session-related errors (-32001) */
  SessionError = -32001,
}

//═══════════════════════════════════════════════════════════════════════════════
// MCP Protocol Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * MCP protocol initialization request from client to server.
 * First message sent to establish protocol version and exchange capabilities.
 * @interface InitializeRequest
 * @see https://modelcontextprotocol.io/docs/specification/protocol
 */
export interface InitializeRequest {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Unique request identifier */
  id: string | number;
  /** MCP initialize method name */
  method: 'initialize';
  /** Initialization parameters */
  params: {
    /** Protocol version that the client supports */
    protocolVersion: string;
    /** Client's capabilities */
    capabilities: ClientCapabilities;
    /** Client identification */
    clientInfo: {
      /** Client name (e.g., "Claude Code") */
      name: string;
      /** Client version */
      version: string;
    };
  };
}

/**
 * MCP protocol initialization response from server to client.
 * Sent in response to InitializeRequest to confirm protocol and capabilities.
 * @interface InitializeResult
 * @see https://modelcontextprotocol.io/docs/specification/protocol
 */
export interface InitializeResult {
  /** Protocol version that the server supports */
  protocolVersion: string;
  /** Server's capabilities */
  capabilities: ServerCapabilities;
  /** Server identification */
  serverInfo: {
    /** Server name (e.g., "Speedwave Hub") */
    name: string;
    /** Server version */
    version: string;
  };
}

/**
 * Capabilities advertised by the MCP client during initialization.
 * Informs server what features the client supports.
 * @interface ClientCapabilities
 * @see https://modelcontextprotocol.io/docs/specification/protocol
 */
export interface ClientCapabilities {
  /** Root filesystem capabilities */
  roots?: {
    /** Whether client can notify server of root list changes */
    listChanged?: boolean;
  };
  /** Sampling/generation capabilities */
  sampling?: Record<string, unknown>;
  /** Experimental features supported by client */
  experimental?: Record<string, unknown>;
}

/**
 * Capabilities advertised by the MCP server during initialization.
 * Informs client what features the server provides.
 * @interface ServerCapabilities
 * @see https://modelcontextprotocol.io/docs/specification/protocol
 */
export interface ServerCapabilities {
  /** Tool/function capabilities */
  tools?: {
    /** Whether server can notify client of tool list changes */
    listChanged?: boolean;
  };
  /** Resource capabilities (files, data sources, etc.) */
  resources?: {
    /** Whether resources support subscription for updates */
    subscribe?: boolean;
    /** Whether server can notify client of resource list changes */
    listChanged?: boolean;
  };
  /** Prompt template capabilities */
  prompts?: {
    /** Whether server can notify client of prompt list changes */
    listChanged?: boolean;
  };
  /** Logging capability — empty object signals support (spec 2025-11-25) */
  logging?: Record<string, never>;
  /** Experimental features provided by server */
  experimental?: Record<string, unknown>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Annotations
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Hints describing a tool's behavior and side effects.
 * Clients may use these to make UI/safety decisions (e.g., auto-approve read-only tools).
 * All fields are optional; the defaults listed are those specified by the MCP spec.
 * @interface ToolAnnotations
 * @see https://modelcontextprotocol.io/docs/specification/tools#annotations
 */
export interface ToolAnnotations {
  /** Human-readable title for display in client UIs */
  title?: string;
  /** If true, the tool does not modify its environment (default: false) */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates (default: true) */
  destructiveHint?: boolean;
  /** If true, calling the tool repeatedly with the same args has no additional effect (default: false) */
  idempotentHint?: boolean;
  /** If true, the tool may interact with external entities beyond its host (default: true) */
  openWorldHint?: boolean;
}

//═══════════════════════════════════════════════════════════════════════════════
// Request Processing Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of processing an incoming JSON-RPC request.
 * Contains the response to send back (or null for notifications) and an optional session ID.
 * @interface ProcessRequestResult
 */
export interface ProcessRequestResult {
  /** JSON-RPC response to send back, or null for notifications that require no response */
  response: JSONRPCResponse | null;
  /** Session ID associated with this request (set during initialization) */
  sessionId?: string;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * MCP tool definition describing a callable function/operation.
 * Tools are exposed by servers and can be invoked by clients.
 * @interface Tool
 * @see https://modelcontextprotocol.io/docs/specification/tools
 */
export interface Tool {
  /** Unique identifier for the tool (e.g., "redmine.getIssue") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** Human-readable title for display in client UIs */
  title?: string;
  /** JSON Schema defining the tool's input parameters */
  inputSchema: {
    /** Schema type, always "object" for MCP tools */
    type: 'object';
    /** Parameter definitions using JSON Schema */
    properties: Record<string, unknown>;
    /** List of required parameter names */
    required?: string[];
  };
  /** Optional examples for tool usage (Anthropic extension) */
  inputExamples?: Array<{
    /** Description of what the example demonstrates */
    description: string;
    /** Example input parameters */
    input: Record<string, unknown>;
  }>;
  /** Search keywords for tool discovery */
  keywords?: string[];
  /** Usage example showing how to call the tool */
  example?: string;
  /** JSON Schema describing the tool's output structure */
  outputSchema?: Record<string, unknown>;
  /** Icons representing the tool for client UIs */
  icons?: Array<{
    /** URI of the icon resource */
    src: string;
    /** MIME type of the icon (e.g., "image/svg+xml") */
    mimeType?: string;
    /** Available icon sizes (e.g., ["32x32", "64x64"]) */
    sizes?: string[];
  }>;
  /** Execution behavior configuration */
  execution?: {
    /** Whether the tool supports long-running task mode */
    taskSupport?: 'forbidden' | 'optional' | 'required';
  };
  /** Behavioral annotations for the tool (hints about side effects) */
  annotations?: ToolAnnotations;
  /** Extension metadata for vendor-specific or experimental fields */
  _meta?: Record<string, unknown>;
}

/**
 * Request to list all available tools from the server.
 * Supports pagination via cursor for large tool sets.
 * @interface ToolsListRequest
 * @see https://modelcontextprotocol.io/docs/specification/tools
 */
export interface ToolsListRequest {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Unique request identifier */
  id: string | number;
  /** MCP tools list method */
  method: 'tools/list';
  /** Optional parameters for pagination */
  params?: {
    /** Cursor for fetching next page of results */
    cursor?: string;
  };
}

/**
 * Response containing list of available tools.
 * May include cursor for pagination if more tools are available.
 * @interface ToolsListResult
 * @see https://modelcontextprotocol.io/docs/specification/tools
 */
export interface ToolsListResult {
  /** Array of tool definitions */
  tools: Tool[];
  /** Cursor for fetching next page (if more tools available) */
  nextCursor?: string;
}

/**
 * Request to invoke/execute a specific tool with provided arguments.
 * @interface ToolsCallRequest
 * @see https://modelcontextprotocol.io/docs/specification/tools
 */
export interface ToolsCallRequest {
  /** JSON-RPC version, always "2.0" */
  jsonrpc: '2.0';
  /** Unique request identifier */
  id: string | number;
  /** MCP tool call method */
  method: 'tools/call';
  /** Tool invocation parameters */
  params: {
    /** Name of the tool to invoke */
    name: string;
    /** Arguments to pass to the tool (must match inputSchema) */
    arguments: Record<string, unknown>;
  };
}

/**
 * Response from a tool invocation containing results or error information.
 * Content can be text, images, or resource references.
 * @interface ToolsCallResult
 * @see https://modelcontextprotocol.io/docs/specification/tools
 */
export interface ToolsCallResult {
  /** Array of content items returned by the tool */
  content: Array<{
    /** Content type discriminator */
    type: 'text' | 'image' | 'resource' | 'audio' | 'resource_link';
    /** Text content (for type: 'text') */
    text?: string;
    /** Base64-encoded data (for type: 'image' or 'audio') */
    data?: string;
    /** MIME type of the content */
    mimeType?: string;
  }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
  /** Structured content conforming to the tool's outputSchema (spec 2025-11-25) */
  structuredContent?: Record<string, unknown>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Session Management Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Represents an active MCP session between client and server.
 * Used for tracking connection state and enforcing timeouts.
 * @interface Session
 */
export interface Session {
  /** Unique session identifier (UUID) */
  id: string;
  /** Timestamp when session was created */
  createdAt: Date;
  /** Timestamp of last activity in this session */
  lastAccessedAt: Date;
  /** Information about the connected client */
  clientInfo?: {
    /** Client name */
    name: string;
    /** Client version */
    version: string;
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// SSE Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Server-Sent Events (SSE) message structure.
 * Used for streaming JSON-RPC messages from server to client over HTTP.
 * @interface SSEEvent
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export interface SSEEvent {
  /** Optional event identifier for client reconnection */
  id?: string;
  /** Event type name (defaults to "message" if omitted) */
  event?: string;
  /** Event payload data (typically JSON-encoded) */
  data: string;
  /** Reconnection time in milliseconds */
  retry?: number;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Handler Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Function signature for implementing a tool's execution logic.
 * Receives validated parameters and returns formatted result.
 * @callback ToolHandler
 * @param {Record<string, unknown>} params - Tool parameters (validated against inputSchema)
 * @returns {Promise<ToolsCallResult>} Tool execution result
 */
export type ToolHandler = (params: Record<string, unknown>) => Promise<ToolsCallResult>;

/**
 * Complete tool definition combining schema and implementation.
 * Used internally by MCP servers to register tools.
 * @interface ToolDefinition
 */
export interface ToolDefinition {
  /** Tool schema and metadata */
  tool: Tool;
  /** Implementation function for the tool */
  handler: ToolHandler;
}

//═══════════════════════════════════════════════════════════════════════════════
// Error Handling Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Generic error shape for catch blocks.
 * Use with isErrorLike() type guard to safely access properties.
 */
export interface ErrorLike {
  message?: string;
  code?: string | number;
  name?: string;
  response?: {
    status?: number;
    statusText?: string;
    data?: {
      message?: string;
      error?: string;
      errors?: unknown;
    };
  };
  data?: {
    error?: string;
    message?: string;
    errors?: unknown;
  };
  stderr?: string;
  cause?: unknown;
}

/**
 * Type guard for ErrorLike - use in catch blocks
 * @param e - Value to check if it is error-like
 * @returns True if the value is error-like (object with error properties)
 * @example
 * catch (error: unknown) {
 *   if (isErrorLike(error)) {
 *     console.log(error.message);
 *   }
 * }
 */
export function isErrorLike(e: unknown): e is ErrorLike {
  return typeof e === 'object' && e !== null;
}
