/**
 * Worker → oauth-worker client (ADR-060). `WORKER_OAUTH_URL` = base URL; bearer path defaults to `/secrets/oauth-auth-token-<service>`.
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

/** Typed error thrown when granted scopes are a strict subset of requested (re-consent trigger). */
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
   * Construct a refresh error.
   * @param code - machine-readable code (drives caller branching)
   * @param message - human-readable error message
   * @param httpStatus - optional HTTP status when the failure was an HTTP response
   */
  constructor(code: OAuthRefreshCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Refresh when the JWT `exp` claim is within this many seconds of now. */
export const PROACTIVE_REFRESH_SECONDS = 120;

/**
 * Read the `exp` claim (UNIX seconds) from a JWT; `null` for malformed/non-JWT tokens.
 * @param token - the JWT to parse
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
 * True when the token's `exp` is within `seconds` of now; `false` for unparseable tokens.
 * @param token - the JWT access token to check
 * @param seconds - the expiry window in seconds
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
 * Refresh the caller's access token by calling the oauth worker. Retries once on 401.
 * @param options - refresh options (service id, bearer path override, worker URL override, fetch override)
 * @throws {OAuthScopeMismatchError} if the granted scopes are insufficient; {@link OAuthRefreshError} for any other failure.
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
    // Fail fast if the oauth worker hangs.
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
      // Wrap fetch failures as typed errors; worker URL stays out of user-facing messages.
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
    // True when the worker skipped the IdP round-trip (token still valid, not rewritten).
    rateLimited: payload.rateLimited === true,
  };
}
