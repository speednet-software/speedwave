/**
 * HTTP Bridge — Hub-to-Worker Communication. Hub has NO tokens; each worker holds only its own
 * service tokens. All communication is JSON-RPC 2.0 over HTTP on the internal Docker network.
 */

import { randomUUID } from 'crypto';
import { buildServiceBridge, getEnabledServices } from './tool-registry.js';
import { getAuthToken } from './auth-tokens.js';
import { getAllServiceNames } from './service-list.js';
import { TIMEOUTS, LATEST_PROTOCOL_VERSION, ts, validateWorkerUrl } from '@speedwave/mcp-shared';
import { deriveWorkerEnv } from './worker-env.js';

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve worker URL for a service from WORKER_{SERVICE}_URL; undefined if unset (not enabled).
 * @param service - service name (e.g. 'slack', 'gitlab')
 */
function getWorkerUrl(service: string): string | undefined {
  const url = process.env[deriveWorkerEnv(service)] || undefined;
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

/** Get current worker request timeout value in milliseconds (for testing). */
export function getRequestTimeout(): number {
  return TIMEOUTS.WORKER_REQUEST_MS;
}

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

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
    /** Array of content items (MCP 2025-11-25: text, image, audio, resource_link, resource). */
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
 * Build standard MCP-compliant headers for worker requests (Content-Type, Accept, Protocol-Ver).
 * Optionally adds Authorization when an auth token is available.
 * @param authToken - Optional bearer token for authentication
 */
export function buildWorkerHeaders(authToken?: string): Record<string, string> {
  // Accept must include both application/json and text/event-stream per MCP spec.
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
 * Parse a worker HTTP response (JSON or SSE) into a JSONRPCResponse.
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

// ── Worker Status Cache ──────────────────────────────────────────────────────────────────────────

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
 * Perform MCP initialize handshake; returns Mcp-Session-Id (empty if stateless), null on fail.
 * @param url - Worker base URL
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
    // Per MCP spec, Mcp-Session-Id header must be echoed on subsequent requests.
    const sessionId = response.headers.get('Mcp-Session-Id') ?? '';
    const result = await parseResponse(response);
    if (result.error) return null;

    // Per MCP spec, notifications/initialized must complete before further requests on the session.
    const notifHeaders = buildWorkerHeaders(authToken);
    if (sessionId) notifHeaders['Mcp-Session-Id'] = sessionId;
    const notifResponse = await fetch(url, {
      method: 'POST',
      headers: notifHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(TIMEOUTS.HEALTH_CHECK_MS),
      redirect: 'error',
    });
    // Spec says 202; permissive servers return 200. Accept 2xx, drain body for socket reuse.
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
 * Single health-check: plain ping, then initialize+ping, then legacy /health GET fallback.
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

  // Attempt 1: plain ping.
  const first = await postPing();
  if (first.ok) return true;

  // Attempt 2: if not initialised, run initialize + retry ping on the session.
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
 * Check if worker is available (with caching).
 * @param service - Service name to check
 * @returns True if worker is available, false otherwise
 */
export async function isWorkerAvailable(service: string): Promise<boolean> {
  const cached = workerStatusCache.get(service);
  const now = new Date();

  if (cached && now.getTime() - cached.lastCheck.getTime() < TIMEOUTS.CACHE_TTL_MS) {
    return cached.available;
  }

  const available = await checkWorkerHealth(service);
  workerStatusCache.set(service, {
    available,
    lastCheck: now,
    tools: [],
  });

  return available;
}

/** Max retries for startup health checks */
export const STARTUP_HEALTH_RETRIES = 3;
/** Delays between startup retries (exponential backoff: 1s, 2s, 4s) */
export const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Delays for tool-registry discovery retries; longer for cold-start I/O workers. Total budget: 30s.
 */
export const DISCOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * Check worker health at startup with retry + backoff.
 * Logs at info (not warn) — startup races are expected.
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
 * Get all currently available service names.
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

// ── Error Parsing ────────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a sanitized, user-friendly error message from an MCP service error, checked in order:
 * GitBeaker cause.description, HTTP response.body/status, network error.code, then error.message.
 * @param error - The raw error from an MCP service call
 * @param serviceName - Name of the service for prefixing (e.g., 'gitlab', 'slack')
 * @returns A sanitized, user-friendly error message
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

// ── HTTP Bridge Functions ────────────────────────────────────────────────────────────────────────

/**
 * Per-service cache of Mcp-Session-Id values; empty string means stateless.
 * Invalidated on 400/404 'not initialized'.
 */
const workerSessionCache: Map<string, string> = new Map();

/**
 * Ensure a worker is initialised; returns cached Mcp-Session-Id (empty if stateless).
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
  /* c8 ignore next — guard for re-entrant callers; current call sites always
   * call invalidateWorkerSession first so the cache is empty on entry */
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
 * Call a worker tool via HTTP bridge; `options.timeoutMs` overrides the default timeout.
 * @param service - Service name (slack, sharepoint, redmine, gitlab)
 * @param toolName - Tool name to call
 * @param params - Tool parameters
 * @param options - Optional configuration (timeoutMs for custom timeout)
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

  // Performs tools/call with an optional cached session id.
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
    // Fast path: use the cached session (or none for permissive workers).
    const cachedSid = workerSessionCache.get(service);
    let response = await attemptCall(cachedSid);

    // On 400/404 'not initialized': invalidate the session, re-init, retry once.
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
      // errorResult() sets isError: true and wraps the message in an "Error: " prefix.
      if (result.result?.isError) {
        const firstText = content.find((c) => c.type === 'text')?.text ?? 'Unknown error';
        throw new Error(firstText);
      }

      // Multi-item responses (e.g. text + base64 image): pass the whole array through.
      const textItems = content.filter((c) => c.type === 'text' && c.text !== undefined);
      const hasNonTextItems = content.some((c) => c.type !== 'text');
      if (hasNonTextItems) {
        return content as T;
      }

      // Single/joined text item: try JSON parse first, fall back to the raw string.
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

// ── Service-Specific Bridge Functions (for executor.ts compatibility) ────────────────────────────

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

// ── Create All Bridges (Lazy Initialization) ─────────────────────────────────────────────────────

/** All service bridges combined; a dynamic Record to support both built-in and plugin services. */
export type AllBridges = Record<string, ReturnType<typeof buildServiceBridge> | null>;

/**
 * Initialize all service bridges (lazy mode): created regardless of availability,
 * health-checked at startup.
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
    const status = workerStatus[service] ? '✅' : '⏳ (will retry on use)';
    console.log(
      `${ts()}    ${service.charAt(0).toUpperCase() + service.slice(1).padEnd(10)}: ${status}`
    );
  }

  return bridges;
}
