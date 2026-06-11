/**
 * Worker → oauth-worker client (ADR-060).
 *
 * Used by OAuth-consuming workers (e.g. SharePoint) to ask the host-side oauth
 * worker for a fresh access token when their current one expires/401s. The
 * caller's service id is derived by the oauth worker from the bearer token
 * mounted at `/secrets/oauth-auth-token-<service>` — there is NO `service`
 * parameter sent on the wire.
 *
 * Env inputs (set by `apply_oauth_config` in compose.rs):
 *   WORKER_OAUTH_URL                  — base URL of the oauth worker
 *   OAUTH_BEARER_PATH                 — path inside the container to the bearer
 *                                       (default `/secrets/oauth-auth-token-<service>`)
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TIMEOUTS } from './timeouts.js';

/** Discriminant for {@link OAuthRefreshError}. */
export type OAuthRefreshCode =
  | 'not_configured'
  | 'no_bearer'
  | 'timeout'
  | 'worker_unreachable'
  | 'http'
  | 'unauthorized'
  | 'jsonrpc'
  | 'malformed'
  | 'tool_error';

/**
 * Typed error thrown when Microsoft refuses the refresh because the granted scopes
 * are a strict subset of the requested scopes (re-consent flow trigger).
 */
export class OAuthScopeMismatchError extends Error {
  /**
   * Construct a scope-mismatch error.
   * @param message - human-readable scope mismatch detail
   */
  constructor(message: string) {
    super(message);
    this.name = 'OAuthScopeMismatchError';
  }
}

/** Generic error for refresh failures other than scope mismatch. */
export class OAuthRefreshError extends Error {
  readonly code: OAuthRefreshCode;
  readonly httpStatus?: number;
  /**
   * Construct a typed refresh error.
   * @param code - machine-readable code (drives caller branching)
   * @param message - human-readable detail (safe to surface to the user)
   * @param httpStatus - optional HTTP status when the failure was an HTTP response
   */
  constructor(code: OAuthRefreshCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Refresh when the JWT `exp` claim is within this many seconds of now. Avoids
 * the 401→refresh→retry round-trip and the race window where the host oauth
 * watchdog has just respawned the worker.
 */
export const PROACTIVE_REFRESH_SECONDS = 120;

/**
 * Read the `exp` claim (UNIX seconds) from a Microsoft Graph access token (JWT).
 * Returns `null` for malformed/non-JWT tokens; callers treat that as "do not
 * refresh proactively" so legacy or test tokens keep working via the 401 path.
 * @param token - JWT access token
 */
export function readJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the access token's `exp` claim is within `seconds` of now (or in
 * the past). Returns `false` for unparseable tokens — they go through the
 * reactive 401 path.
 * @param token - JWT access token
 * @param seconds - refresh window
 * @param nowMs - injectable clock for tests
 */
export function accessTokenExpiresWithin(
  token: string,
  seconds: number,
  nowMs: number = Date.now()
): boolean {
  const exp = readJwtExp(token);
  if (exp === null) return false;
  return exp * 1000 - nowMs < seconds * 1000;
}

/**
 * Options for {@link refreshAccessToken}.
 */
export interface OAuthRefreshOptions {
  /** Caller's service id (used to resolve the bearer path; never sent on the wire). */
  service: string;
  /** Override the bearer path. Default `/secrets/oauth-auth-token-<service>`. */
  bearerPath?: string;
  /** Override the worker URL env var. Default `WORKER_OAUTH_URL`. */
  workerUrl?: string;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
}

interface MCPToolsCallResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/**
 * Refresh the caller's access token by calling the oauth worker. Returns the
 * parsed response body (`{expiresIn, grantedScopes}`) on success. The caller
 * then re-reads `/tokens/access_token` — the oauth worker has written the new
 * value during this call.
 *
 * Retries once on a 401 (handles supervisor restart that rotated the bearer).
 * @param options - service id and optional overrides
 * @throws {OAuthScopeMismatchError} if the granted scopes are insufficient
 * @throws {OAuthRefreshError} for any other failure
 */
export async function refreshAccessToken(
  options: OAuthRefreshOptions
): Promise<{ expiresIn: number; grantedScopes: string[]; rateLimited?: boolean }> {
  const workerUrl = process.env[options.workerUrl ?? 'WORKER_OAUTH_URL'];
  if (!workerUrl) {
    throw new OAuthRefreshError(
      'not_configured',
      `${options.workerUrl ?? 'WORKER_OAUTH_URL'} env var is not set; oauth worker is not enabled for this project`
    );
  }
  const bearerPath = options.bearerPath ?? `/secrets/oauth-auth-token-${options.service}`;

  const fetchImpl = options.fetchImpl ?? fetch;

  const callOnce = async (): Promise<MCPToolsCallResponse> => {
    const bearer = (await readFile(bearerPath, 'utf8')).trim();
    if (!bearer) {
      throw new OAuthRefreshError(
        'no_bearer',
        `bearer file ${bearerPath} is empty; oauth worker did not provision this consumer`
      );
    }
    // Loopback HTTP call to the host-side oauth worker — if it hangs we want
    // to fail the caller's tool invocation rather than block its handler.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOKEN_REFRESH_MS);
    let response: Response;
    try {
      response = await fetchImpl(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name: 'refresh', arguments: {} },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // undici/Node's fetch throws TypeError("fetch failed") on TCP refused
      // (stale ephemeral port after worker respawn). Wrap as typed errors so
      // callers can branch without parsing message strings. Worker URL stays
      // out of the user-facing message — it leaks the ephemeral oauth port.
      if (err instanceof Error && err.name === 'AbortError') {
        console.warn(`oauth worker timeout at ${workerUrl}`);
        const secs = TIMEOUTS.TOKEN_REFRESH_MS / 1000;
        throw new OAuthRefreshError(
          'timeout',
          `oauth worker did not respond within ${secs}s. Restart the project from Speedwave Desktop.`
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`oauth worker unreachable at ${workerUrl}: ${detail}`);
      throw new OAuthRefreshError(
        'worker_unreachable',
        `cannot reach oauth worker: ${detail}. Restart the project from Speedwave Desktop.`
      );
    } finally {
      clearTimeout(timeoutId);
    }
    if (response.status === 401) {
      throw new OAuthRefreshError('unauthorized', 'oauth worker returned 401', 401);
    }
    if (!response.ok) {
      throw new OAuthRefreshError(
        'http',
        `oauth worker HTTP ${response.status}: ${response.statusText}`
      );
    }
    return (await response.json()) as MCPToolsCallResponse;
  };

  let body: MCPToolsCallResponse;
  try {
    body = await callOnce();
  } catch (err) {
    if (err instanceof OAuthRefreshError && err.httpStatus === 401) {
      body = await callOnce();
    } else {
      throw err;
    }
  }

  if (body.error) {
    throw new OAuthRefreshError('jsonrpc', `${body.error.code}: ${body.error.message}`);
  }
  if (!body.result) {
    throw new OAuthRefreshError('malformed', 'oauth worker returned neither result nor error');
  }

  const text = body.result.content?.[0]?.text ?? '';
  if (body.result.isError) {
    if (text.startsWith('Error: scope_mismatch')) {
      throw new OAuthScopeMismatchError(text);
    }
    throw new OAuthRefreshError('tool_error', text);
  }

  // jsonResult shape: { content: [{type:'text', text: JSON.stringify(data)}] }
  let payload: { expiresIn?: unknown; grantedScopes?: unknown; rateLimited?: unknown };
  try {
    payload = JSON.parse(text) as { expiresIn?: unknown; grantedScopes?: unknown };
  } catch {
    throw new OAuthRefreshError('malformed', `unparseable oauth response: ${text}`);
  }
  const expiresIn = payload.expiresIn;
  const grantedScopes = payload.grantedScopes;
  if (typeof expiresIn !== 'number' || !Array.isArray(grantedScopes)) {
    throw new OAuthRefreshError('malformed', `unexpected oauth response shape: ${text}`);
  }
  return {
    expiresIn,
    grantedScopes: grantedScopes.map((s) => String(s)),
    // True when the worker skipped the IdP round-trip (token still valid) —
    // the on-disk access token was deliberately NOT rewritten.
    rateLimited: payload.rateLimited === true,
  };
}
