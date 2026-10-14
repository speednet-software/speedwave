/**
 * Shared MCP infrastructure for Speedwave workers: reusable server components, security
 * utilities, and protocol handlers, eliminating duplication across MCP services.
 */

export type {
  JSONRPCRequest,
  JSONRPCNotification,
  JSONRPCResponse,
  JSONRPCError,
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
  Session,
  SSEEvent,
  ToolHandler,
  ToolHandlerContext,
  ToolDefinition,
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

export {
  loadToken,
  loadTokenFile,
  loadPluginSettings,
  PLUGIN_SETTINGS_FILE,
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

export {
  withResultValidation,
  withClientValidation,
  withDeclaredParams,
} from './tool-validation.js';
export type {
  ToolResult,
  ClientValidationOptions,
  ResultValidationOptions,
} from './tool-validation.js';

export { handleMCPPost, handleMCPDelete, readSessionId } from './transport.js';

export { SessionManager, sessionManager } from './session.js';
export type { SessionManagerOptions } from './session.js';

export { JSONRPCHandler, JSONRPCErrorBuilder } from './jsonrpc.js';
export type { JSONRPCHandlerOptions } from './jsonrpc.js';

export { SSEStream, createSSEStream, sendJSONResponse } from './sse.js';

export { createMCPServer, textResult, jsonResult, errorResult } from './server.js';
export type { MCPServerAuth, MCPServerOptions, MCPServer } from './server.js';

export { bootWorker } from './boot.js';
export type { BootWorkerOptions, NotConfiguredPolicy } from './boot.js';

export { TIMEOUTS } from './timeouts.js';

export { ts } from './logger.js';
export { sanitize } from './sanitizer.js';

export { notConfiguredMessage, withSetupGuidance } from './errors.js';

export {
  teachingErrorResult,
  teachingToolResult,
  clampPageSize,
  missingParamResult,
  MAX_RECEIVED_LENGTH,
} from './teaching-errors.js';
export type { TeachingErrorParams } from './teaching-errors.js';

export { normalizeNumericId, normalizeNumericIdParams } from './numeric-id.js';
export type {
  NumericIdError,
  NumericIdResult,
  NumericIdOptions,
  NumericIdParamsResult,
} from './numeric-id.js';

export { META_KEYS, metaValue } from './meta-keys.js';
export type { MetaKey } from './meta-keys.js';

export { retryAsync } from './retry.js';
export type { RetryOptions } from './retry.js';

export { writeRestrictedSecret } from './restricted-write.js';

export {
  refreshAccessToken,
  OAuthScopeMismatchError,
  OAuthRefreshError,
  readJwtExp,
  accessTokenExpiresWithin,
  PROACTIVE_REFRESH_SECONDS,
} from './oauth-client.js';
export type { OAuthRefreshOptions, OAuthRefreshCode } from './oauth-client.js';

export { authedRequest, authedSdkCall, RefreshLock } from './oauth-authed-request.js';
export type {
  AuthedRefreshContext,
  AuthedRequestOptions,
  AuthedSdkCallOptions,
  AuthedTokenState,
} from './oauth-authed-request.js';

export {
  ConnectionStatusTracker,
  makeStandardHealthCheck,
  backgroundConnectionTest,
  DEFAULT_WARMUP_MS,
} from './health-status.js';
export type { ConnectionStatus, HealthStatus } from './health-status.js';

export { memoizedPromise } from './promise-memo.js';
export type { MemoizedPromiseOptions } from './promise-memo.js';

export { classifyConnectionError } from './connection-test.js';
export type { ConnectionTestResult, ConnectionErrorType } from './connection-test.js';
