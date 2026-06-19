/**
 * Atlassian HTTP client for the MCP worker.
 *
 * Thin wrapper over `axios` (no external Atlassian SDK — see
 * `docs/guides/integrations.md`). Provides:
 * - Basic auth (`Authorization: Basic base64(email:api_token)`).
 * - A **per-request** retry policy (NOT a global interceptor): only requests
 *   explicitly marked `retryable` (GET / idempotent reads) retry transient
 *   `5xx`; every request retries `429` while honouring `Retry-After`, with a
 *   bounded number of attempts and exponential backoff + jitter. Write
 *   operations pass `retryable: false` so a `5xx` mid-write is surfaced rather
 *   than blindly replayed.
 * - {@link AtlassianClient.formatError}: maps errors to user-facing messages and
 *   guarantees the `Authorization` header / base64 blob / raw token never leak.
 * @module mcp-atlassian/client
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import {
  ts,
  withSetupGuidance,
  TIMEOUTS,
  ConnectionStatusTracker,
  backgroundConnectionTest,
} from '@speedwave/mcp-shared';
import type { ConnectionTestResult, HealthStatus } from '@speedwave/mcp-shared';
import { readCredentials } from './auth.js';
import type { AtlassianConfig } from './types.js';
import { ScopeError } from './scope.js';

export type { AtlassianConfig } from './types.js';
export type { ConnectionTestResult } from '@speedwave/mcp-shared';

/** Max retry attempts (in addition to the initial try). */
const MAX_RETRIES = 3;
/** Base backoff in ms; attempt N waits `BASE_DELAY_MS * 2^(N-1)` plus jitter. */
const BASE_DELAY_MS = 1000;
/** Cap on any single backoff wait, ms (also caps a `Retry-After` we honour). */
const MAX_DELAY_MS = 20_000;

/** Per-request options layered on top of `AxiosRequestConfig`. */
interface RequestOptions {
  /**
   * Whether transient `5xx` errors should be retried. Use `true` only for GET /
   * idempotent reads; write operations must pass `false` (the default) so a
   * server error mid-write is not blindly replayed. `429` is retried regardless
   * (it means "you sent too fast", not "the write may have happened").
   */
  retryable?: boolean;
}

/**
 * Sleep for `ms` milliseconds.
 * @param ms - Delay in milliseconds.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms, clamped.
 * @param header - The raw `Retry-After` header value (string, or anything).
 * @returns Milliseconds to wait (clamped to {@link MAX_DELAY_MS}), or `null` if unparseable.
 */
function parseRetryAfter(header: unknown): number | null {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_DELAY_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_DELAY_MS);
  return null;
}

/**
 * Exponential backoff with full jitter for attempt `n` (1-based).
 * @param n - The retry attempt number, 1-based.
 * @returns A randomised delay in milliseconds.
 */
function backoff(n: number): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS);
  return Math.floor(Math.random() * exp);
}

/**
 * Atlassian Cloud REST client (Jira v3 + Agile 1.0, Confluence v2 + v1).
 * Domain modules in `./domains/` call the low-level {@link get}/{@link post}/etc.
 * helpers; this class owns auth, retry policy, pagination and error formatting.
 * @class AtlassianClient
 */
export class AtlassianClient {
  private readonly http: AxiosInstance;
  private readonly config: AtlassianConfig;
  /** Connection status tracker. Updated by background test scheduled in init. */
  public readonly statusTracker = new ConnectionStatusTracker();

  /** Shared health snapshot. Read by the index.ts healthCheck callback. */
  getHealthStatus(): HealthStatus {
    return this.statusTracker.getHealth();
  }

  /**
   * Build the client from a resolved configuration.
   * @param config - Resolved worker configuration (from `/tokens`).
   * @throws {Error} If `config.siteUrl` is not an `https://*.atlassian.net`
   *   origin (`readCredentials` already enforces this, but a directly-constructed
   *   config must not bypass the SSRF-prevention guard).
   */
  constructor(config: AtlassianConfig) {
    if (!/^https:\/\/[^/]+\.atlassian\.net$/.test(config.siteUrl)) {
      throw new Error(
        `AtlassianClient: siteUrl must be an https://*.atlassian.net origin (got: ${config.siteUrl})`
      );
    }
    this.config = config;
    const basic = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.http = axios.create({
      baseURL: config.siteUrl,
      timeout: TIMEOUTS.API_CALL_MS,
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // No redirects; avoids leaking the Authorization header cross-host.
      maxRedirects: 0,
    });
  }

  /** Configured Jira project allowlist (empty = unrestricted). */
  get jiraProjectKeys(): readonly string[] {
    return this.config.jiraProjectKeys;
  }

  /** Configured Confluence space allowlist (empty = unrestricted). */
  get confluenceSpaceKeys(): readonly string[] {
    return this.config.confluenceSpaceKeys;
  }

  //═══════════════════════════════════════════════════════════════════════════
  // Core request with per-request retry
  //═══════════════════════════════════════════════════════════════════════════

  /**
   * Issue an HTTP request with the per-request retry policy applied.
   * @template T - Expected response body type.
   * @param config - Axios request config (method/url/params/data/...).
   * @param opts - {@link RequestOptions} (notably `retryable`).
   * @returns The response body.
   */
  async request<T>(config: AxiosRequestConfig, opts: RequestOptions = {}): Promise<T> {
    const retryable = opts.retryable === true;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.http.request<T>(config);
        return res.data;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_RETRIES) break;

        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const isRateLimited = status === 429;
        const isTransient5xx = typeof status === 'number' && status >= 500 && status <= 599;
        // 429 always retried; 5xx only when retryable (idempotent).
        if (!isRateLimited && !(retryable && isTransient5xx)) break;

        const retryAfter =
          isRateLimited && axios.isAxiosError(error)
            ? parseRetryAfter(error.response?.headers?.['retry-after'])
            : null;
        const wait = retryAfter ?? backoff(attempt + 1);
        console.warn(
          `${ts()} [mcp-atlassian] ${config.method ?? 'GET'} ${config.url} → ${status}; retry ${
            attempt + 1
          }/${MAX_RETRIES} in ${wait}ms`
        );
        await sleep(wait);
      }
    }
    throw lastError;
  }

  /**
   * GET (retried on transient `5xx` and `429`; see {@link request}).
   * @param url - Path relative to the site base URL.
   * @param params - Optional query parameters.
   * @returns The response body.
   */
  get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>({ method: 'GET', url, params }, { retryable: true });
  }

  /**
   * POST. By default **not** retried on `5xx` (only `429`) — pass
   * `{ retryable: true }` only for endpoints that are semantically idempotent
   * (e.g. JQL/CQL search via POST). See {@link request}.
   * @param url - Path relative to the site base URL.
   * @param data - Optional request body.
   * @param opts - Per-request options (notably `retryable`).
   * @returns The response body.
   */
  post<T>(url: string, data?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>({ method: 'POST', url, data }, opts);
  }

  /**
   * PUT. Not retried on `5xx` by default (writes). See {@link request}.
   * @param url - Path relative to the site base URL.
   * @param data - Optional request body.
   * @param opts - Per-request options (notably `retryable`).
   * @returns The response body.
   */
  put<T>(url: string, data?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>({ method: 'PUT', url, data }, opts);
  }

  /**
   * DELETE. Not retried on `5xx` by default. See {@link request}.
   * @param url - Path relative to the site base URL.
   * @param params - Optional query parameters.
   * @returns The response body.
   */
  del<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>({ method: 'DELETE', url, params });
  }

  //═══════════════════════════════════════════════════════════════════════════
  // Connectivity
  //═══════════════════════════════════════════════════════════════════════════

  /**
   * Lightweight connectivity/credentials check (`GET /rest/api/3/myself`).
   * @returns `{ success: true }` on 2xx, otherwise `{ success: false, error }`.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.get<unknown>('/rest/api/3/myself');
      return { success: true };
    } catch (error) {
      return { success: false, error: AtlassianClient.formatError(error) };
    }
  }

  //═══════════════════════════════════════════════════════════════════════════
  // Error formatting (secret-safe)
  //═══════════════════════════════════════════════════════════════════════════

  /**
   * Map an error to a concise, user-facing message. Guarantees no credential
   * material (`Authorization` header value, base64 `email:token`, raw token)
   * appears in the output even if it somehow reached the error object.
   * @param error - Anything thrown by a client call.
   * @returns A safe, human-readable message.
   */
  static formatError(error: unknown): string {
    if (error instanceof ScopeError) return error.message;

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as
        | { errorMessages?: string[]; errors?: Record<string, string>; message?: string }
        | undefined;
      const apiMessage =
        (Array.isArray(data?.errorMessages) && data?.errorMessages.join('; ')) ||
        (data?.errors && Object.values(data.errors).join('; ')) ||
        data?.message ||
        '';

      if (status === 401) {
        return withSetupGuidance(
          'Atlassian authentication failed. Check the account email and API token.'
        );
      }
      if (status === 403) {
        return 'Atlassian permission denied. The account may lack permission for this project/space, or the API token is restricted.';
      }
      if (status === 404) {
        return `Atlassian resource not found${apiMessage ? `: ${apiMessage}` : '. Check the key/ID and that the account has access.'}`;
      }
      if (status === 429) {
        return 'Atlassian rate limit exceeded. Try again shortly.';
      }
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return `Atlassian request error (${status})${apiMessage ? `: ${apiMessage}` : ''}`;
      }
      if (typeof status === 'number' && status >= 500) {
        return 'Atlassian server error. Try again later.';
      }
      // No response: use the code, never the config (carries Authorization).
      const code = error.code ? ` (${error.code})` : '';
      return `Atlassian request failed${code}: unable to reach ${this.safeHost(error.config?.baseURL)}`;
    }

    if (error instanceof Error) return AtlassianClient.scrub(error.message);
    return AtlassianClient.scrub(String(error));
  }

  /**
   * Extract just the host from a URL string, for safe error messages.
   * @param url - A URL string (or anything).
   * @returns The host portion, or `"Atlassian"` if it isn't a parseable URL.
   */
  private static safeHost(url: unknown): string {
    if (typeof url !== 'string') return 'Atlassian';
    try {
      return new URL(url).host;
    } catch {
      return 'Atlassian';
    }
  }

  /**
   * Defensive scrub: redact anything that looks like a credential.
   * The `ATATT…` pattern must stay in sync with the `ATATT` rule in
   * `crates/speedwave-runtime/src/log_sanitizer.rs` (`{20,}` suffix).
   * @param message - A message that may contain credential material.
   * @returns The message with Basic-auth blobs and Atlassian tokens redacted.
   */
  private static scrub(message: string): string {
    return message
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***REDACTED***')
      .replace(/ATATT[A-Za-z0-9_-]{20,}/g, '***REDACTED_ATLASSIAN_TOKEN***');
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an {@link AtlassianClient} from the `/tokens` mount and verify
 * connectivity. Returns `null` (without throwing) if credentials are missing,
 * invalid, or the connection test fails — the worker then starts in "not
 * configured" mode and every tool returns a clear error.
 * @returns The initialized client, or `null`.
 */
export async function initializeAtlassianClient(): Promise<AtlassianClient | null> {
  try {
    const config = await readCredentials();
    if (!config) return null;

    const client = new AtlassianClient(config);
    backgroundConnectionTest(
      client.statusTracker,
      async () => {
        const result = await client.testConnection();
        if (!result.success) {
          throw new Error(result.error ?? 'connection test failed');
        }
      },
      'Atlassian'
    );
    console.log(
      `${ts()} ✅ Atlassian client initialized (site: ${new URL(config.siteUrl).host}), connection test scheduled`
    );
    return client;
  } catch (error) {
    console.warn(
      `${ts()} Failed to initialize Atlassian client: ${AtlassianClient.formatError(error)}`
    );
    return null;
  }
}
