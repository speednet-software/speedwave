/**
 * Shared MCP infrastructure for Speedwave workers.
 * Eliminates code duplication across MCP services by providing
 * reusable server components, security utilities, and protocol handlers.
 *
 * Usage:
 * ```typescript
 * import {
 *   createMCPServer,
 *   loadToken,
 *   textResult,
 *   jsonResult,
 *   errorResult,
 * } from '@speedwave/mcp-shared';
 *
 * const server = createMCPServer({
 *   name: 'my-service',
 *   version: '1.0.0',
 *   port: 3001,
 *   tools: [
 *     { tool: myTool, handler: myHandler },
 *   ],
 * });
 *
 * server.start();
 * ```
 * @module speedwave/mcp-shared
 */

// Types
export type {
  // JSON-RPC types
  JSONRPCRequest,
  JSONRPCNotification,
  JSONRPCResponse,
  JSONRPCError,
  // MCP types
  InitializeRequest,
  InitializeResult,
  ClientCapabilities,
  ServerCapabilities,
  Tool,
  ToolAnnotations,
  ToolsListRequest,
  ToolsListResult,
  ToolsCallRequest,
  ToolsCallResult,
  // Session types
  Session,
  // SSE types
  SSEEvent,
  // Tool types
  ToolHandler,
  ToolDefinition,
  // Transport types
  ProcessRequestResult,
} from './types.js';

export {
  JSONRPCErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from './types.js';

// Security
export {
  loadToken,
  validateJSONRPCMessage,
  validateParams,
  validateSessionId,
  validateToolName,
  validateWorkerUrl,
  validateOrigin,
} from './security.js';

// Transport
export { handleMCPPost, handleMCPDelete, readSessionId } from './transport.js';

// Session
export { SessionManager, sessionManager } from './session.js';
export type { SessionManagerOptions } from './session.js';

// JSON-RPC
export { JSONRPCHandler, JSONRPCErrorBuilder } from './jsonrpc.js';
export type { JSONRPCHandlerOptions } from './jsonrpc.js';

// SSE
export { SSEStream, createSSEStream, sendJSONResponse } from './sse.js';

// Server Factory
export { createMCPServer, textResult, jsonResult, errorResult } from './server.js';
export type { MCPServerAuth, MCPServerOptions, MCPServer } from './server.js';

// Timeouts
export { TIMEOUTS } from './timeouts.js';

// Logger
export { ts } from './logger.js';

// Errors (SSOT for user-facing messages)
export { notConfiguredMessage, withSetupGuidance } from './errors.js';

// Retry
export { retryAsync } from './retry.js';
export type { RetryOptions } from './retry.js';
