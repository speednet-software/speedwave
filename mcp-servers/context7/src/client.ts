/**
 * Context7 REST API client.
 *
 * Talks directly to `https://context7.com/api/v2/*` — same backend the
 * upstream `@upstash/context7-mcp` server proxies to.
 *
 * Anonymous mode (no API key): per-IP rate limit (~200 req/day on
 * `ratelimit-limit` header), see docs/architecture/security.md.
 * @module mcp-context7/client
 */

import { request, Dispatcher } from 'undici';
import {
  BASE_URL,
  MAX_OUTPUT_TOKENS,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_RESULTS,
  MIN_OUTPUT_TOKENS,
  REQUEST_TIMEOUT_MS,
  SERVER_VERSION,
} from './consts.js';
import { Context7CallResult, Context7Library, QuotaTier, SearchResponse } from './types.js';

/** Construction options for {@link Context7Client}. */
export interface Context7ClientOptions {
  /** Optional Context7 API key (`ctx7sk_…`). Falsy = anonymous mode. */
  apiKey?: string;
  /** Override the base URL (tests). */
  baseUrl?: string;
  /** Custom undici dispatcher (mocked in tests). */
  dispatcher?: Dispatcher;
}

/** Typed error thrown for non-retryable Context7 failures. */
export class Context7Error extends Error {
  /** HTTP status from Context7 (0 when no response). */
  readonly status: number;
  /** Quota tier reported by the server (when available). */
  readonly tier: QuotaTier;
  /** Whether {@link Context7Client} should retry transparently. */
  readonly retryable: boolean;

  /**
   * Build a typed Context7 error with HTTP status and quota tier preserved.
   * @param message - Human-readable message
   * @param status - HTTP status code (0 = network/timeout)
   * @param tier - Quota tier reported by server
   * @param retryable - Whether the call may be retried
   */
  constructor(message: string, status: number, tier: QuotaTier, retryable: boolean) {
    super(message);
    this.name = 'Context7Error';
    this.status = status;
    this.tier = tier;
    this.retryable = retryable;
  }
}

/** Retryable transient statuses (5xx). */
const RETRY_STATUS = new Set([500, 502, 503, 504]);

/** Total retry attempts after the initial call. */
const MAX_RETRIES = 3;

/** Base for exponential backoff. */
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * REST client wrapping Context7's search and context endpoints.
 *
 * Stateless aside from the options bag — safe to share across tool calls.
 */
export class Context7Client {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly dispatcher: Dispatcher | undefined;

  /**
   * Create a client with optional API key and dispatcher overrides.
   * @param opts - Client options (see {@link Context7ClientOptions})
   */
  constructor(opts: Context7ClientOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.dispatcher = opts.dispatcher;
  }

  /** Whether the client is operating in anonymous (no-key) mode. */
  get anonymous(): boolean {
    return this.apiKey === undefined;
  }

  /**
   * Resolve a library name to Context7-compatible IDs.
   * @param libraryName - Free-text name (e.g. `"react"`)
   * @param query - User intent — used to rank results
   * @returns Top-N libraries plus the reported quota tier
   */
  async searchLibraries(
    libraryName: string,
    query: string
  ): Promise<Context7CallResult<Context7Library[]>> {
    if (!libraryName.trim()) {
      throw new Context7Error('libraryName must not be empty', 0, 'unknown', false);
    }
    if (!query.trim()) {
      throw new Context7Error('query must not be empty', 0, 'unknown', false);
    }
    const url = `${this.baseUrl}/libs/search?libraryName=${encodeURIComponent(
      libraryName
    )}&query=${encodeURIComponent(query)}`;
    const { data, tier } = await this.fetchJSON<SearchResponse>(url);
    const results = Array.isArray(data.results) ? data.results.slice(0, MAX_SEARCH_RESULTS) : [];
    return { data: results, tier };
  }

  /**
   * Fetch documentation snippets for a known library ID.
   * @param libraryId - Context7 library ID (e.g. `/facebook/react`)
   * @param query - User question
   * @param tokens - Output cap (clamped to {@link MIN_OUTPUT_TOKENS}..{@link MAX_OUTPUT_TOKENS})
   * @returns Plain-text documentation block plus the reported quota tier
   */
  async getContext(
    libraryId: string,
    query: string,
    tokens: number
  ): Promise<Context7CallResult<string>> {
    if (!libraryId.trim()) {
      throw new Context7Error('libraryId must not be empty', 0, 'unknown', false);
    }
    if (!query.trim()) {
      throw new Context7Error('query must not be empty', 0, 'unknown', false);
    }
    const clamped = clampTokens(tokens);
    const url = `${this.baseUrl}/context?libraryId=${encodeURIComponent(
      libraryId
    )}&query=${encodeURIComponent(query)}&tokens=${clamped}`;
    return this.fetchText(url);
  }

  /**
   * GET + JSON parse with retry. Caller validates schema.
   * @param url - Fully constructed URL (must be on `this.baseUrl`).
   */
  private async fetchJSON<T>(url: string): Promise<Context7CallResult<T>> {
    const { body, tier } = await this.fetchRaw(url, 'application/json');
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Context7Error('Context7 returned non-JSON response', 0, tier, false);
    }
    return { data: data as T, tier };
  }

  /**
   * GET + return body as plain text (used for `/context` which returns text/plain).
   * @param url - Fully constructed URL
   */
  private async fetchText(url: string): Promise<Context7CallResult<string>> {
    const { body, tier } = await this.fetchRaw(url, 'text/plain');
    return { data: body, tier };
  }

  /**
   * Core fetch with retry, error mapping, and tier extraction.
   * @param url - Fully constructed URL
   * @param accept - `Accept` header value
   */
  private async fetchRaw(url: string, accept: string): Promise<{ body: string; tier: QuotaTier }> {
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': `Speedwave-Context7/${SERVER_VERSION}`,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let lastError: Context7Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // undici v7/v8: redirects opt-in via the `redirect` interceptor —
        // we never set it, so 3xx surfaces as a status we treat as an error
        // in mapErrorStatus (defence-in-depth, mirrors ADR-041 host policy).
        const response = await request(url, {
          method: 'GET',
          headers,
          dispatcher: this.dispatcher,
          bodyTimeout: REQUEST_TIMEOUT_MS,
          headersTimeout: REQUEST_TIMEOUT_MS,
        });
        const tier = headerToTier(response.headers['context7-quota-tier']);
        const body = await readBodyLimited(response.body, MAX_RESPONSE_BYTES, tier);
        const status = response.statusCode;

        if (status === 200) {
          return { body, tier };
        }
        // Non-200: throw; the catch below makes the single retry decision.
        throw mapErrorStatus(status, body, response.headers, tier, !!this.apiKey);
      } catch (e) {
        if (e instanceof Context7Error) {
          if (!e.retryable || attempt === MAX_RETRIES) throw e;
          lastError = e;
        } else {
          const network = new Context7Error(
            `Context7 request failed: ${(e as Error).message}`,
            0,
            'unknown',
            true
          );
          if (attempt === MAX_RETRIES) throw network;
          lastError = network;
        }
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
    // Unreachable — loop either returns or throws — but keeps the compiler happy.
    /* c8 ignore next */
    throw lastError ?? new Context7Error('Context7 retries exhausted', 0, 'unknown', true);
  }
}

/**
 * Map a Context7 HTTP status to a {@link Context7Error}.
 *
 * Centralised so handlers and tests share the same vocabulary.
 * @param status - HTTP status from Context7
 * @param body - Response body (already read)
 * @param headers - Response headers (used for `ratelimit-reset`)
 * @param tier - Quota tier extracted from response
 * @param hasApiKey - Whether the client had an API key configured
 * @returns Typed Context7 error
 */
function mapErrorStatus(
  status: number,
  body: string,
  headers: Record<string, string | string[] | undefined>,
  tier: QuotaTier,
  hasApiKey: boolean
): Context7Error {
  const bodyMsg = extractMessage(body);

  if (status === 202) {
    return new Context7Error(
      'Library indexing in progress — call this tool again in a moment.',
      status,
      tier,
      false
    );
  }
  if (status >= 300 && status < 400) {
    return new Context7Error(
      `Unexpected redirect (HTTP ${status}) — Context7 redirects are not followed`,
      status,
      tier,
      false
    );
  }
  if (status === 400) {
    return new Context7Error(`Bad request: ${bodyMsg}`, status, tier, false);
  }
  if (status === 401) {
    return new Context7Error(
      "Invalid API key (expected prefix 'ctx7sk_'). Remove the key in Settings → Integrations → Context7 to fall back to anonymous mode.",
      status,
      tier,
      false
    );
  }
  if (status === 403) {
    return new Context7Error(
      `Forbidden: ${bodyMsg} (private repo or quota tier mismatch?)`,
      status,
      tier,
      false
    );
  }
  if (status === 404) {
    return new Context7Error(
      'Library not found. Call resolveLibraryId first.',
      status,
      tier,
      false
    );
  }
  if (status === 422) {
    return new Context7Error(
      `Unprocessable entity: ${bodyMsg} (likely malformed libraryId).`,
      status,
      tier,
      false
    );
  }
  if (status === 429) {
    const reset = parseResetHeader(headers['ratelimit-reset']);
    const suffix = hasApiKey
      ? 'Upgrade your plan at https://context7.com/plans for higher limits.'
      : 'Add an API key at https://context7.com/dashboard for higher limits.';
    return new Context7Error(
      `Rate limit exceeded. Tier: ${tier}. ${reset ? `Resets at ${reset}. ` : ''}${suffix}`,
      status,
      tier,
      false
    );
  }
  if (RETRY_STATUS.has(status)) {
    return new Context7Error(
      `Context7 transient error (HTTP ${status}): ${bodyMsg}`,
      status,
      tier,
      true
    );
  }
  return new Context7Error(`Context7 returned status ${status}: ${bodyMsg}`, status, tier, false);
}

/**
 * Extract a human-readable message from a Context7 error body, falling back
 * to the truncated raw body when the body is not JSON.
 * @param body - Raw response body
 */
function extractMessage(body: string): string {
  if (!body) return '(empty body)';
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed && typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // Fall through to truncated raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/**
 * Parse Context7's `ratelimit-reset` header. The value is a Unix timestamp in
 * seconds; returns a formatted ISO date or `null` when missing/invalid.
 * @param raw - Header value (string, array, or undefined)
 */
function parseResetHeader(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const ts = Number(v);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

/**
 * Map the `context7-quota-tier` header to our typed tier enum, defaulting to
 * `"unknown"` when the header is missing or carries an unrecognised value.
 * @param raw - Header value (string, array, or undefined)
 */
function headerToTier(raw: string | string[] | undefined): QuotaTier {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  if (v === 'anonymous' || v === 'free' || v === 'pro' || v === 'enterprise') return v;
  return 'unknown';
}

/**
 * Clamp the `tokens` parameter to Context7's accepted range and our cap.
 * @param tokens - Requested token cap
 */
export function clampTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return MIN_OUTPUT_TOKENS;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, Math.floor(tokens)));
}

/**
 * Sleep for `ms` milliseconds — used by the retry loop.
 * @param ms - Duration in milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drain a response body to a string, throwing if it would exceed `maxBytes`.
 *
 * Undici's `.text()` has no byte ceiling — a 500 MB upstream response would
 * be buffered in full, bounded only by the 128 MiB container cap (OOM kill,
 * not a clean error). This iterates chunks with a running byte counter and
 * aborts cleanly before memory pressure becomes a problem.
 * @param body - Undici response body (AsyncIterable of Buffer chunks)
 * @param maxBytes - Upper bound on total bytes
 * @param tier - Quota tier to attach to the error
 */
async function readBodyLimited(
  body: Dispatcher.ResponseData['body'],
  maxBytes: number,
  tier: QuotaTier
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      body.destroy();
      throw new Context7Error(`Context7 response exceeded ${maxBytes} bytes`, 0, tier, false);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
