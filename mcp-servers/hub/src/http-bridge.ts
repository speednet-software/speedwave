/**
 * HTTP Bridge - Hub-to-Worker Communication
 * @module http-bridge
 *
 * Enables mcp-hub to call isolated MCP workers via HTTP.
 * Each worker only has access to its own service tokens.
 *
 * Architecture:
 * - Hub (this service) has NO tokens - only orchestrates
 * - Workers have per-service token isolation
 * - All communication via JSON-RPC 2.0 over HTTP
 *
 * Security:
 * - Internal Docker network only (no exposed ports)
 * - Network isolation provides security - no host access
 */

import { randomUUID } from 'crypto';
import { buildServiceBridge, getEnabledServices } from './tool-registry.js';
import { getAuthToken } from './auth-tokens.js';
import { getAllServiceNames } from './service-list.js';
import { TIMEOUTS, LATEST_PROTOCOL_VERSION, ts, validateWorkerUrl } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve worker URL for a given service from WORKER_{SERVICE}_URL env var.
 * Returns undefined if the env var is not set (service not enabled).
 * @param service - service name (e.g. 'slack', 'gitlab')
 */
function getWorkerUrl(service: string): string | undefined {
  const url = process.env[`WORKER_${service.toUpperCase()}_URL`] || undefined;
  if (!url) return undefined;

  if (!validateWorkerUrl(url)) {
    console.error(`${ts()} [http-bridge] SSRF protection: rejected worker URL for ${service}`);
    return undefined;
  }

  return url;
}

/**
 * Get all services that have a WORKER_*_URL env var configured.
 * Includes both built-in and plugin services.
 */
function getConfiguredServices(): string[] {
  return getAllServiceNames().filter((service) => Boolean(getWorkerUrl(service)));
}

/**
 * Get current worker request timeout value (for testing)
 * @returns Current timeout in milliseconds
 */
export function getRequestTimeout(): number {
  return TIMEOUTS.WORKER_REQUEST_MS;
}

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Worker response structure
 */
export interface WorkerResponse<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Response data if successful */
  data?: T;
  /** Error message if failed */
  error?: string;
}

/**
 * JSON-RPC 2.0 response from worker
 */
export interface JSONRPCResponse {
  /** JSON-RPC version */
  jsonrpc: '2.0';
  /** Request ID */
  id: string | number;
  /** Result object containing MCP response */
  result?: {
    /**
     * Array of content items. MCP spec 2025-11-25 §Tool Result defines
     * several `type` values: `"text"`, `"image"` (base64 + mimeType),
     * `"audio"`, `"resource_link"`, and `"resource"`. Our hub keeps the
     * shape open so third-party servers (e.g. `@playwright/mcp` returns
     * a text summary followed by a base64 PNG in the same array) don't
     * lose structured output.
     */
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    /** Set by errorResult() when worker returns an error */
    isError?: boolean;
  };
  /** Error object if request failed */
  error?: {
    /** Error code */
    code: number;
    /** Error message */
    message: string;
  };
}

/**
 * Build standard MCP-compliant headers for worker requests.
 * Includes Content-Type, Accept (JSON + SSE), and MCP-Protocol-Version.
 * Optionally adds Authorization header when an auth token is available.
 * @param authToken - Optional bearer token for authentication
 */
export function buildWorkerHeaders(authToken?: string): Record<string, string> {
  // Accept must include both application/json and text/event-stream
  // per MCP spec — worker servers validate this header (transport.ts)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return headers;
}

/**
 * Parse a worker HTTP response, handling both JSON and SSE content types.
 * MCP spec allows servers to respond with either application/json or
 * text/event-stream. For SSE responses, extracts the first `data:` line
 * that contains valid JSON.
 * @param response - HTTP Response from a worker
 * @returns Parsed JSON-RPC response
 */
export async function parseResponse(response: Response): Promise<JSONRPCResponse> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const json = line.slice(6).trim();
        if (json) {
          try {
            return JSON.parse(json) as JSONRPCResponse;
          } catch (error) {
            const preview = json.length > 100 ? json.substring(0, 100) + '...' : json;
            throw new Error(
              `Failed to parse SSE JSON-RPC response (status ${response.status}): ${error instanceof Error ? error.message : String(error)}. Data: "${preview}"`
            );
          }
        }
      }
    }
    // Fail hard with the full body so we can see what the worker actually
    // sent. This happens in practice when third-party MCP servers emit
    // progress frames (`event: progress`, `event: ping`, ...) before the
    // final `data:` line and the stream gets cut off mid-flight.
    const bodyDump = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
    throw new Error(
      `No JSON-RPC response in SSE stream (status ${response.status}, ${text.length} bytes). Body:\n${bodyDump}`
    );
  }
  try {
    return (await response.json()) as JSONRPCResponse;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON response (status ${response.status}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Worker Status Cache
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Worker status cache entry
 */
interface WorkerStatus {
  /** Whether worker is currently available */
  available: boolean;
  /** Last time availability was checked */
  lastCheck: Date;
  /** List of tools provided by this worker */
  tools: string[];
}

const workerStatusCache: Map<string, WorkerStatus> = new Map();

/**
 * Clear worker status cache (for testing)
 */
export function clearWorkerCache(): void {
  workerStatusCache.clear();
}

/**
 * Classify a health-check error for logging.
 * @param error - The caught error value
 */
function classifyHealthError(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN';
  if (error.name === 'AbortError') return 'TIMEOUT';
  if ('code' in error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTFOUND') return 'DNS_ERROR';
    if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
    if (code) return code;
  }
  if (error.message.includes('TLS') || error.message.includes('SSL')) return 'TLS_ERROR';
  return 'UNKNOWN';
}

/**
 * Attempt an `initialize` handshake against a worker.
 *
 * Strict MCP servers (e.g. `@playwright/mcp`) reject every request with
 * `Bad Request: Server not initialized` until `initialize` completes AND the
 * returned `Mcp-Session-Id` header is sent on every subsequent request.
 * In-house workers are more permissive and answer `ping` without any of
 * this.
 *
 * This helper is called both by `checkWorkerHealth` (startup health path)
 * and by `ensureWorkerSession` (per-call session management) when
 * initialization is required.
 *
 * Returns the `Mcp-Session-Id` assigned by the worker (or an empty string if
 * the worker does not use sessions) on success, and `null` on failure.
 * @param url - Worker base URL (same URL the ping POST is issued against)
 * @param authToken - Optional bearer token
 */
async function performMcpInitialize(url: string, authToken?: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildWorkerHeaders(authToken),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'speedwave-hub', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUTS.HEALTH_CHECK_MS),
      redirect: 'error',
    });
    // MCP spec 2025-11-25 §Session Management:
    //   "A server … MAY assign a session ID at initialization time, by
    //    including it in an `MCP-Session-Id` header on the HTTP response
    //    containing the InitializeResult."
    // HTTP headers are case-insensitive per RFC 7230, so `Mcp-Session-Id`
    // reads the same header the server wrote, but we keep the canonical
    // capitalisation when echoing it back on subsequent requests to make
    // trace logs line up with the spec.
    const sessionId = response.headers.get('Mcp-Session-Id') ?? '';
    const result = await parseResponse(response);
    if (result.error) return null;

    // MCP spec 2025-11-25 §Lifecycle + §Streamable HTTP:
    //   After InitializeResult the client MUST send
    //   `notifications/initialized`. Strict servers (e.g. `@playwright/mcp`)
    //   refuse every subsequent request with 400 "Server not initialized"
    //   until this notification has been POSTed and ACK'd with 202 Accepted.
    // Critically, this must complete BEFORE we return — the caller
    // immediately issues `tools/call` on the session we just built, and any
    // race with the notification makes the tool call fail.
    const notifHeaders = buildWorkerHeaders(authToken);
    if (sessionId) notifHeaders['Mcp-Session-Id'] = sessionId;
    const notifResponse = await fetch(url, {
      method: 'POST',
      headers: notifHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(TIMEOUTS.HEALTH_CHECK_MS),
      redirect: 'error',
    });
    // Spec says notifications return 202 Accepted; permissive servers may
    // return 200. Anything in the 2xx range is fine. Drain the body so the
    // underlying socket can be reused for the next request.
    await notifResponse.text().catch(() => undefined);
    if (!notifResponse.ok) {
      console.error(
        `${ts()} [http-bridge] notifications/initialized rejected with ${notifResponse.status} — session is unusable`
      );
      return null;
    }

    return sessionId;
  } catch (error) {
    const errorType = classifyHealthError(error);
    console.warn(
      `${ts()} [http-bridge] initialize handshake failed for ${url} [${errorType}]: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Single health-check using MCP `ping` method with `/health` endpoint fallback.
 *
 * Flow:
 *   1. Plain MCP `ping` — fast path for our in-house workers that respond to
 *      `ping` on a fresh connection.
 *   2. `initialize` handshake followed by `ping` — required by strict MCP
 *      servers like `@playwright/mcp` that refuse every request with
 *      `Bad Request: Server not initialized` until the session is
 *      initialised. This is the spec-compliant flow and the only way to
 *      talk to most third-party MCP servers.
 *   3. Legacy `/health` GET — backwards compatibility with any remaining
 *      worker that predates MCP-over-HTTP.
 *
 * Returns `true` when any of the three attempts succeeds.
 * @param service - Service name to check
 */
async function checkWorkerHealth(service: string): Promise<boolean> {
  const url = getWorkerUrl(service);
  if (!url) return false;

  const authToken = getAuthToken(service);

  const postPing = async (
    sessionId?: string
  ): Promise<{ ok: boolean; notInitialised: boolean }> => {
    try {
      const headers = buildWorkerHeaders(authToken);
      if (sessionId) {
        headers['Mcp-Session-Id'] = sessionId;
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'ping',
        }),
        signal: AbortSignal.timeout(TIMEOUTS.HEALTH_CHECK_MS),
        redirect: 'error',
      });
      const result = await parseResponse(response);
      if (!result.error) return { ok: true, notInitialised: false };
      return {
        ok: false,
        notInitialised: result.error.message.toLowerCase().includes('not initialized'),
      };
    } catch (error) {
      const errorType = classifyHealthError(error);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `${ts()} [http-bridge] MCP ping failed for ${service} [${errorType}]: ${message}`
      );
      return { ok: false, notInitialised: message.toLowerCase().includes('not initialized') };
    }
  };

  // Attempt 1: plain ping (fast path for permissive workers).
  const first = await postPing();
  if (first.ok) return true;

  // Attempt 2: if the server told us it needed initialisation, do it and
  // retry the ping on the same session. Strict MCP servers assign a
  // session ID via the Mcp-Session-Id response header on initialize and
  // reject subsequent requests that do not echo it back.
  if (first.notInitialised) {
    const sessionId = await performMcpInitialize(url, authToken);
    if (sessionId !== null) {
      const second = await postPing(sessionId);
      if (second.ok) return true;
    }
  }

  // Attempt 3: legacy /health endpoint (backwards compatibility).
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(TIMEOUTS.HEALTH_CHECK_MS),
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if worker is available (with caching)
 * @param service - Service name to check
 * @returns True if worker is available, false otherwise
 */
export async function isWorkerAvailable(service: string): Promise<boolean> {
  const cached = workerStatusCache.get(service);
  const now = new Date();

  if (cached && now.getTime() - cached.lastCheck.getTime() < TIMEOUTS.CACHE_TTL_MS) {
    return cached.available;
  }

  try {
    const available = await checkWorkerHealth(service);
    workerStatusCache.set(service, {
      available,
      lastCheck: now,
      tools: [],
    });

    return available;
  } catch (error) {
    const errorType = classifyHealthError(error);
    console.warn(
      `${ts()} [http-bridge] Worker health check failed for ${service} [${errorType}]:`,
      error instanceof Error ? error.message : error
    );
    workerStatusCache.set(service, {
      available: false,
      lastCheck: now,
      tools: [],
    });
    return false;
  }
}

/** Max retries for startup health checks */
export const STARTUP_HEALTH_RETRIES = 3;
/** Delays between startup retries (exponential backoff: 1s, 2s, 4s) */
export const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Check worker health at startup with retry + backoff.
 * Logs at info level (not warn) because startup races are expected.
 * @param service - Service name to check
 */
async function checkWorkerHealthAtStartup(service: string): Promise<boolean> {
  // 4 total attempts: attempt 0 (first try) + 3 retries
  for (let attempt = 0; attempt <= STARTUP_HEALTH_RETRIES; attempt++) {
    try {
      const ok = await checkWorkerHealth(service);
      if (ok) return true;
    } catch {
      // expected during startup — worker may not be listening yet
    }

    if (attempt < STARTUP_HEALTH_RETRIES) {
      const delay = STARTUP_RETRY_DELAYS_MS[attempt] ?? 4_000;
      console.log(
        `${ts()} [http-bridge] Worker ${service} not ready, retrying in ${delay / 1000}s (${attempt + 1}/${STARTUP_HEALTH_RETRIES})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.log(
    `${ts()} [http-bridge] Worker ${service} not available after ${STARTUP_HEALTH_RETRIES} retries — will retry lazily on use`
  );
  return false;
}

/**
 * Get all available services
 * @returns Array of service names that are currently available
 */
export async function getAvailableServices(): Promise<string[]> {
  const services = getConfiguredServices();
  const results = await Promise.all(
    services.map(async (service) => ({
      service,
      available: await isWorkerAvailable(service),
    }))
  );

  return results.filter((r) => r.available).map((r) => r.service);
}

//═══════════════════════════════════════════════════════════════════════════════
// Error Parsing
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Parses and extracts meaningful error messages from MCP service errors.
 * Handles various error structures from different APIs (GitLab, Slack, SharePoint, etc.).
 *
 * Error sources handled:
 * - GitBeaker: error.cause.description, error.response.body.message
 * - HTTP errors: error.response.status, error.response.body.error
 * - Network errors: error.code (ECONNREFUSED, ETIMEDOUT)
 * - Generic errors: error.message
 * @param {unknown} error - The raw error from an MCP service call
 * @param {string} serviceName - Name of the service for prefixing (e.g., 'gitlab', 'slack')
 * @returns {string} A sanitized, user-friendly error message
 * @example
 * parseServiceError({ cause: { description: 'Invalid token' } }, 'gitlab')
 * // → 'gitlab: Invalid token'
 *
 * parseServiceError({ response: { status: 404 } }, 'gitlab')
 * // → 'gitlab: Resource not found'
 */
export function parseServiceError(error: unknown, serviceName: string): string {
  const prefix = serviceName ? `${serviceName}: ` : '';

  if (!(error instanceof Error) && typeof error !== 'object') {
    return `${prefix}${String(error)}`;
  }

  const err = error as {
    cause?: {
      description?: string;
      response?: { status?: number; body?: unknown };
    };
    response?: {
      status?: number;
      body?: { message?: string; error?: string };
    };
    code?: string;
    message?: string | object;
  };

  // GitBeaker style: error.cause.description
  if (err.cause?.description) {
    return `${prefix}${err.cause.description}`;
  }

  // HTTP response body message
  if (err.response?.body) {
    const body = err.response.body;
    if (typeof body === 'object' && body !== null) {
      if ('message' in body && body.message) {
        return `${prefix}${body.message}`;
      }
      if ('error' in body && body.error) {
        return `${prefix}${body.error}`;
      }
    }
  }

  // HTTP status codes
  if (err.response?.status) {
    const status = err.response.status;
    const statusMessages: Record<number, string> = {
      400: 'Bad request - check parameters',
      401: 'Authentication failed - check token',
      403: 'Permission denied - insufficient privileges',
      404: 'Resource not found',
      429: 'Rate limit exceeded - try again later',
      500: 'Server error',
      502: 'Bad gateway',
      503: 'Service unavailable',
    };
    return `${prefix}${statusMessages[status] || `HTTP error ${status}`}`;
  }

  // Network errors
  if (err.code) {
    const networkMessages: Record<string, string> = {
      ECONNREFUSED: 'Connection refused - service not reachable',
      ETIMEDOUT: 'Connection timeout - service not responding',
      ENOTFOUND: 'Host not found - check URL',
    };
    if (networkMessages[err.code]) {
      return `${prefix}${networkMessages[err.code]}`;
    }
  }

  // Standard error message
  if (err.message) {
    if (typeof err.message === 'object') {
      return `${prefix}${JSON.stringify(err.message)}`;
    }
    return `${prefix}${err.message}`;
  }

  return `${prefix}Unknown error`;
}

//═══════════════════════════════════════════════════════════════════════════════
// HTTP Bridge Functions
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-service cache of `Mcp-Session-Id` values issued by workers.
 *
 * Strict MCP servers (`@playwright/mcp`) reject every JSON-RPC request with
 * `Bad Request: Server not initialized` unless the caller both completed
 * `initialize` and echoes back the `Mcp-Session-Id` header the worker set in
 * the initialize response. We remember that header per service and replay it
 * on subsequent `tools/call` requests. An empty string means the worker
 * issued no session header (stateless worker) — we still store it so we
 * don't re-initialize on every call.
 *
 * On a `400 Bad Request` with "not initialized" (worker restarted, session
 * expired) the entry is invalidated and `ensureWorkerSession` re-runs
 * `initialize`.
 */
const workerSessionCache: Map<string, string> = new Map();

/**
 * Ensures a worker has been initialised for the current hub process and
 * returns the `Mcp-Session-Id` to echo on subsequent requests (empty string
 * if the worker is stateless). Caches per service; subsequent callers hit
 * the cache.
 * @param service - Service name
 * @param url - Worker base URL
 * @param authToken - Optional bearer token
 */
async function ensureWorkerSession(
  service: string,
  url: string,
  authToken?: string
): Promise<string> {
  const cached = workerSessionCache.get(service);
  if (cached !== undefined) return cached;

  const sessionId = await performMcpInitialize(url, authToken);
  if (sessionId === null) {
    throw new Error(`Worker ${service}: initialize handshake failed`);
  }
  workerSessionCache.set(service, sessionId);
  return sessionId;
}

/**
 * Drop a cached session — used on `not initialized` 400 responses and on
 * explicit transport errors so the next call re-runs `initialize`.
 * @param service - Service name whose session to invalidate
 */
function invalidateWorkerSession(service: string): void {
  workerSessionCache.delete(service);
}

/**
 * Clear the per-service MCP session cache.
 * Named with `_` prefix to signal it is a test hook — call only from test files.
 */
export function _clearWorkerSessionCacheForTesting(): void {
  workerSessionCache.clear();
}

/**
 * Call a worker tool via HTTP bridge
 * @param service Service name (slack, sharepoint, redmine, gitlab)
 * @param toolName Tool name to call
 * @param params Tool parameters
 * @param options Optional configuration (timeoutMs for custom timeout)
 * @param options.timeoutMs - Custom timeout in milliseconds for this specific call
 * @returns Tool result
 */
export async function callWorker<T = unknown>(
  service: string,
  toolName: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<T> {
  const url = getWorkerUrl(service);

  if (!url) {
    throw new Error(`Unknown service: ${service}`);
  }

  const timeout = options?.timeoutMs ?? TIMEOUTS.WORKER_REQUEST_MS;
  const authToken = getAuthToken(service);

  // Helper: performs the actual tools/call request with an optional cached
  // session id. Separate so we can retry once after session invalidation
  // without duplicating the request body / error handling.
  const attemptCall = async (sessionId: string | undefined): Promise<Response> => {
    const headers = buildWorkerHeaders(authToken);
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: params,
        },
      }),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
  };

  try {
    // Fast path: try the call with whatever session is cached (or none, for
    // permissive workers that never required `initialize`). This keeps the
    // round-trip count at 1 for the common case — only strict MCP servers
    // (`@playwright/mcp`) that reject with 400 "not initialized" pay the
    // cost of an extra initialize handshake.
    const cachedSid = workerSessionCache.get(service);
    let response = await attemptCall(cachedSid);

    // Strict MCP servers signal session trouble in two ways:
    //   * 400 "Server not initialized" — no session on this request at all.
    //   * 404 Not Found               — the Mcp-Session-Id we just sent has
    //                                    expired or refers to a worker
    //                                    instance that has since restarted.
    // Both cases are recoverable by invalidating the cached session and
    // running `initialize` (+ `notifications/initialized`) again before
    // retrying the call exactly once.
    if (response.status === 400 || response.status === 404) {
      const body = await response.text();
      const bodyLower = body.toLowerCase();
      const looksLikeSessionIssue =
        bodyLower.includes('not initialized') ||
        (response.status === 404 &&
          (bodyLower.includes('session') || bodyLower.includes('not found')));
      if (looksLikeSessionIssue) {
        console.warn(
          `${ts()} [http-bridge] ${service}: ${response.status} on tools/call (${body.slice(0, 200)}) — re-initialising session`
        );
        invalidateWorkerSession(service);
        const sessionId = await ensureWorkerSession(service, url, authToken);
        response = await attemptCall(sessionId);
      } else {
        throw new Error(`Worker ${service} returned ${response.status}: ${body.slice(0, 200)}`);
      }
    }

    if (!response.ok) {
      throw new Error(`Worker ${service} returned ${response.status}: ${response.statusText}`);
    }

    const result = await parseResponse(response);

    if (result.error) {
      throw new Error(`Worker ${service} error: ${result.error.message}`);
    }

    // Extract content from MCP response.
    const content = result.result?.content;
    if (content && content.length > 0) {
      // Check if worker returned an error (e.g., notConfiguredMessage('Redmine'))
      // errorResult() sets isError: true and wraps message in "Error: " prefix.
      if (result.result?.isError) {
        const firstText = content.find((c) => c.type === 'text')?.text ?? 'Unknown error';
        throw new Error(firstText);
      }

      // Multi-item responses are spec-compliant (MCP 2025-11-25 §Tool Result:
      // "can contain multiple content items of different types"). A strict
      // server like `@playwright/mcp` returns a text summary followed by a
      // base64 `image` item on `browser_take_screenshot`. Pass the whole
      // array through so the executor / caller can forward every item — the
      // image is useless without its sibling text describing the screenshot,
      // and vice versa.
      const textItems = content.filter((c) => c.type === 'text' && c.text !== undefined);
      const hasNonTextItems = content.some((c) => c.type !== 'text');
      if (hasNonTextItems) {
        return content as T;
      }

      // Single text item — legacy shape used by all in-house workers.
      // MCP spec 2025-11-25 §Tool Result → Text Content defines the content
      // item as `{ "type": "text", "text": "Tool result text" }` — any
      // string is valid, no JSON requirement. Our workers happen to wrap
      // JSON because their bridge API returns structured data. Try JSON
      // first so existing workers keep their typed shape; fall back to
      // the raw string when parsing fails. Multiple text items are joined
      // with newlines before the JSON attempt.
      const text = textItems.map((c) => c.text).join('\n');
      try {
        return JSON.parse(text) as T;
      } catch {
        console.warn(
          `${ts()} [http-bridge] ${service}.${toolName}: non-JSON text response (${text.length} bytes) — passing through as string`
        );
        return text as T;
      }
    }

    return result.result as T;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Worker ${service} timeout after ${timeout}ms`);
    }

    console.error(
      `${ts()} [http-bridge] callWorker(${service}, ${toolName}) failed:`,
      error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error)
    );
    throw error;
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Service-Specific Bridge Functions (for executor.ts compatibility)
//═══════════════════════════════════════════════════════════════════════════════

/** Create Slack bridge for executor sandbox. */
export function createSlackBridge() {
  return buildServiceBridge('slack', callWorker);
}

/** Create SharePoint bridge for executor sandbox. */
export function createSharePointBridge() {
  return buildServiceBridge('sharepoint', callWorker);
}

/** Create Redmine bridge for executor sandbox. */
export function createRedmineBridge() {
  return buildServiceBridge('redmine', callWorker);
}

/** Create GitLab bridge for executor sandbox. */
export function createGitLabBridge() {
  return buildServiceBridge('gitlab', callWorker);
}

/** Create OS bridge for executor sandbox (Reminders, Calendar, Mail, Notes). */
export function createOsBridge() {
  return buildServiceBridge('os', callWorker);
}

//═══════════════════════════════════════════════════════════════════════════════
// Create All Bridges (Lazy Initialization)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * All service bridges combined.
 * Dynamic Record type to support both built-in and plugin services.
 */
export type AllBridges = Record<string, ReturnType<typeof buildServiceBridge> | null>;

/**
 * Initialize all service bridges
 *
 * IMPORTANT: Bridges are always created regardless of worker availability.
 * Each bridge call checks worker health lazily - if a worker becomes available
 * after Hub startup, it will work on the next call.
 *
 * This fixes the race condition where Hub starts before workers are ready.
 * @returns All initialized bridges
 */
export async function initializeAllBridges(): Promise<AllBridges> {
  console.log(`${ts()} 🔗 Initializing HTTP bridges to workers (lazy mode)...`);

  const enabledServices = getEnabledServices();
  const allServices = getAllServiceNames();

  const bridges: AllBridges = {};
  for (const service of allServices) {
    bridges[service] = enabledServices.has(service)
      ? buildServiceBridge(service, callWorker)
      : null;
  }

  // Check initial status with retry+backoff (workers may still be starting)
  const activeServices = allServices.filter((s) => enabledServices.has(s));
  const statusChecks = await Promise.all(activeServices.map((s) => checkWorkerHealthAtStartup(s)));
  const workerStatus = Object.fromEntries(activeServices.map((s, i) => [s, statusChecks[i]]));

  // Seed the cache so subsequent calls don't re-check immediately
  const now = new Date();
  for (let i = 0; i < activeServices.length; i++) {
    workerStatusCache.set(activeServices[i], {
      available: statusChecks[i],
      lastCheck: now,
      tools: [],
    });
  }

  const enabledCount = statusChecks.filter(Boolean).length;

  console.log(
    `${ts()} \n📊 Workers available at startup: ${enabledCount}/${activeServices.length}`
  );
  for (const service of allServices) {
    if (!enabledServices.has(service)) {
      console.log(
        `${ts()}    ${service.charAt(0).toUpperCase() + service.slice(1).padEnd(10)}: disabled`
      );
    } else {
      const status = workerStatus[service] ? '✅' : '⏳ (will retry on use)';
      console.log(
        `${ts()}    ${service.charAt(0).toUpperCase() + service.slice(1).padEnd(10)}: ${status}`
      );
    }
  }

  return bridges;
}
