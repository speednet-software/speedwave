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
  ToolHandlerContext,
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
  loadTokenFile,
  tokensDir,
  BASE_SAFE_ENV_KEYS,
  validateJSONRPCMessage,
  validateParams,
  validateSessionId,
  validateToolName,
  validateWorkerUrl,
  validateOrigin,
  HOST_GATEWAY_ALIAS,
} from './security.js';

// Tool-handler validation wrappers (SSOT for the two withValidation families)
export { withResultValidation, withClientValidation } from './tool-validation.js';
export type { ToolResult, ClientValidationOptions } from './tool-validation.js';

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

// Declarative worker boot (SSOT for every worker's main())
export { bootWorker } from './boot.js';
export type { BootWorkerOptions, NotConfiguredPolicy } from './boot.js';

// Timeouts
export { TIMEOUTS } from './timeouts.js';

// Logger
export { ts } from './logger.js';
export { sanitize } from './sanitizer.js';

// Errors (SSOT for user-facing messages)
export { notConfiguredMessage, withSetupGuidance } from './errors.js';

// Retry
export { retryAsync } from './retry.js';
export type { RetryOptions } from './retry.js';

// Atomic owner-only file write (mirrors Rust crate::fs_perms::write_restricted_file)
export { writeRestrictedSecret } from './restricted-write.js';

// Worker → oauth worker client (ADR-060)
export {
  refreshAccessToken,
  OAuthScopeMismatchError,
  OAuthRefreshError,
  readJwtExp,
  accessTokenExpiresWithin,
  PROACTIVE_REFRESH_SECONDS,
} from './oauth-client.js';
export type { OAuthRefreshOptions, OAuthRefreshCode } from './oauth-client.js';

// Shared reactive refresh-retry loop (ADR-060/069) — SSOT for all OAuth consumers
export { authedRequest, authedSdkCall, RefreshLock } from './oauth-authed-request.js';
export type {
  AuthedRefreshContext,
  AuthedRequestOptions,
  AuthedSdkCallOptions,
  AuthedTokenState,
} from './oauth-authed-request.js';

// Connection status tracking (workers with external dependencies)
export {
  ConnectionStatusTracker,
  makeStandardHealthCheck,
  backgroundConnectionTest,
  DEFAULT_WARMUP_MS,
} from './health-status.js';
export type { ConnectionStatus, HealthStatus } from './health-status.js';

// Promise memoization with cache-on-failure
export { memoizedPromise } from './promise-memo.js';
export type { MemoizedPromiseOptions } from './promise-memo.js';

// Connection test result classification
export { classifyConnectionError } from './connection-test.js';
export type { ConnectionTestResult, ConnectionErrorType } from './connection-test.js';
