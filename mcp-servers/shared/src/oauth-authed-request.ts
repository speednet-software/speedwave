/**
 * SSOT reactive refresh-retry every OAuth consumer shares: on an auth-failure
 * status, refresh once and retry. See ADR-060 (host refresh), ADR-069 (plugins).
 */
import { join } from 'node:path';
import { loadToken } from './security.js';
import {
  refreshAccessToken,
  accessTokenExpiresWithin,
  OAuthScopeMismatchError,
  type OAuthRefreshOptions,
} from './oauth-client.js';

/** RFC 6750 status for a stale token; GLPI also misuses 400, so it's opt-in. */
const DEFAULT_AUTH_FAILURE_STATUSES = [401];

/** Serializes refreshes so concurrent 401s trigger one refresh, not N. */
class RefreshLock {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` after any in-flight holder; resolves with its result.
   * @param fn - work to run while holding the lock
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Per-service token state shared between {@link authedRequest} calls. */
export interface AuthedTokenState {
  /** Current access token (mutated in place on refresh). */
  accessToken: string;
}

/** Options for {@link authedRequest}. */
export interface AuthedRequestOptions {
  /** Service id for the oauth worker (e.g. `sharepoint`, `glpi`). */
  service: string;
  /** Mutable token holder; `accessToken` is updated after a refresh. */
  state: AuthedTokenState;
  /** Per-service refresh serializer (one per client instance). */
  lock: RefreshLock;
  /**
   * Issues the request with the given bearer. Called up to twice (initial +
   * post-refresh retry). Must NOT add its own Authorization header.
   */
  send: (accessToken: string) => Promise<Response>;
  /** `/tokens` dir override (defaults to `TOKENS_DIR` env or `/tokens`). */
  tokensDir?: string;
  /** Proactively refresh when the token expires within this window (seconds). */
  proactiveWithinSeconds?: number;
  /** Statuses that trigger refresh+retry (default `[401]`; GLPI adds 400). */
  authFailureStatuses?: readonly number[];
  /** Forwarded to {@link refreshAccessToken} (worker URL, bearer path, fetch). */
  refresh?: Omit<OAuthRefreshOptions, 'service'>;
}

/** Re-export so vendored plugin copies stay self-contained. */
export { RefreshLock };

/**
 * Refresh the caller's token via the oauth worker, then re-read the fresh value
 * the worker wrote into `/tokens/access_token`. Mutates `state.accessToken`.
 * @param opts - the authed-request options carrying service, state, and refresh config
 */
async function refreshInto(opts: AuthedRequestOptions): Promise<void> {
  await refreshAccessToken({ service: opts.service, ...opts.refresh });
  const dir = opts.tokensDir ?? process.env.TOKENS_DIR ?? '/tokens';
  const fresh = await loadToken(join(dir, 'access_token'));
  if (!fresh) {
    throw new Error('oauth worker reported success but access_token was not written');
  }
  opts.state.accessToken = fresh;
}

/**
 * Execute an authenticated request with shared refresh-retry semantics.
 * @param opts - service id, mutable token state, refresh lock, and `send`
 * @returns the final {@link Response} (caller checks `response.ok`)
 * @throws {OAuthScopeMismatchError} when the IdP needs re-consent
 */
export async function authedRequest(opts: AuthedRequestOptions): Promise<Response> {
  const failureStatuses = opts.authFailureStatuses ?? DEFAULT_AUTH_FAILURE_STATUSES;

  // Proactive refresh is an optimization: on failure fall through to the
  // reactive path with the current token. A scope mismatch can't self-heal.
  if (
    typeof opts.proactiveWithinSeconds === 'number' &&
    accessTokenExpiresWithin(opts.state.accessToken, opts.proactiveWithinSeconds)
  ) {
    try {
      await refreshOnce(opts);
    } catch (err) {
      if (err instanceof OAuthScopeMismatchError) throw err;
    }
  }

  const response = await opts.send(opts.state.accessToken);
  if (!failureStatuses.includes(response.status)) return response;

  await refreshOnce(opts);
  return opts.send(opts.state.accessToken);
}

/**
 * Refresh under the lock, unless another caller already rotated the token.
 * @param opts - the authed-request options
 */
async function refreshOnce(opts: AuthedRequestOptions): Promise<void> {
  const before = opts.state.accessToken;
  await opts.lock.run(async () => {
    if (opts.state.accessToken === before) await refreshInto(opts);
  });
}
