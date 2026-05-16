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
  readonly code: string;
  /**
   * Construct a refresh error with a machine-readable code and a human detail.
   * @param code - machine-readable error code from the oauth worker
   * @param message - human-readable detail
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
  }
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
): Promise<{ expiresIn: number; grantedScopes: string[] }> {
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
    // 30s timeout on the loopback HTTP call to the host-side oauth worker.
    // The worker is local and refresh is fast in practice; if it hangs (the
    // worker stalled mid-refresh, mid-fsync, etc.) we want to fail the
    // caller's tool invocation rather than block its handler forever.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
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
    } finally {
      clearTimeout(timeoutId);
    }
    if (response.status === 401) {
      const err = new OAuthRefreshError('unauthorized', 'oauth worker returned 401');
      (err as { httpStatus?: number }).httpStatus = 401;
      throw err;
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
    if (err instanceof OAuthRefreshError && (err as { httpStatus?: number }).httpStatus === 401) {
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
  let payload: { expiresIn?: unknown; grantedScopes?: unknown };
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
  };
}
