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
import { TIMEOUTS, ts, validateWorkerUrl } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

/**
 * List of all supported MCP worker services.
 * Adding a new service: add to this array and create corresponding bridge function.
 */
export const SERVICES = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'] as const;

/** Union type of all supported service names derived from SERVICES array. */
export type ServiceName = (typeof SERVICES)[number];

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
    /** Array of content items */
    content: Array<{ type: string; text?: string }>;
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
 * Single health-check fetch (no cache, no retry).
 * Returns true when the worker responds with 2xx.
 * @param service - Service name to check
 */
async function checkWorkerHealth(service: string): Promise<boolean> {
  const url = getWorkerUrl(service);
  if (!url) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.HEALTH_CHECK_MS);

  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
      redirect: 'error',
    });
    return response.ok;
  } finally {
    clearTimeout(timeoutId);
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

  const requestId = randomUUID();
  const timeout = options?.timeoutMs ?? TIMEOUTS.WORKER_REQUEST_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authToken = getAuthToken(service);
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: params,
        },
      }),
      signal: controller.signal,
      redirect: 'error',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Worker ${service} returned ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as JSONRPCResponse;

    if (result.error) {
      throw new Error(`Worker ${service} error: ${result.error.message}`);
    }

    // Extract text content from MCP response
    const content = result.result?.content;
    if (content && content.length > 0 && content[0].text) {
      const text = content[0].text;

      // Check if worker returned an error (e.g., notConfiguredMessage('Redmine'))
      // errorResult() sets isError: true and wraps message in "Error: " prefix
      if (result.result?.isError) {
        throw new Error(text);
      }

      // Try to parse as JSON (normal response)
      try {
        return JSON.parse(text) as T;
      } catch (parseError) {
        const preview = text.length > 100 ? text.substring(0, 100) + '...' : text;
        console.error(
          `${ts()} [http-bridge] Worker ${service} returned invalid JSON:`,
          `Preview: "${preview}"`,
          `Parse error: ${parseError instanceof Error ? parseError.message : parseError}`
        );
        throw new Error(
          `Worker ${service} returned invalid response format. Expected JSON but received: ${preview}`
        );
      }
    }

    return result.result as T;
  } catch (error: unknown) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Worker ${service} timeout after ${timeout}ms`);
    }

    console.error(
      `${ts()} [http-bridge] callWorker(${service}, ${toolName}) failed:`,
      error instanceof Error ? error.message : error
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
