/**
 * SSOT reactive refresh-retry every OAuth consumer shares: on an auth-failure
 * status, refresh once and retry. See ADR-060 (host refresh), ADR-069 (plugins).
 */
import { join } from 'node:path';
import { loadToken } from './security.js';
import { ts } from './logger.js';
import {
  refreshAccessToken,
  accessTokenExpiresWithin,
  OAuthScopeMismatchError,
} from './oauth-client.js';

/** RFC 6750 status for a stale token; GLPI also misuses 400, so it's opt-in. */
const DEFAULT_AUTH_FAILURE_STATUSES = [401];

/**
 * Serializes refreshes so concurrent failures trigger one refresh, not N. The
 * `generation` counter lets callers detect "someone already refreshed" without
 * relying on the new token differing from the old one.
 */
export class RefreshLock {
  private tail: Promise<void> = Promise.resolve();
  /** Bumped on every completed refresh; callers compare it for single-flight. */
  generation = 0;

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

/** Common refresh context shared by {@link authedRequest} and {@link authedSdkCall}. */
export interface AuthedRefreshContext {
  /** Service id for the oauth worker (e.g. `sharepoint`, `slack`). */
  readonly service: string;
  /** Mutable token holder; `accessToken` is updated after a refresh. */
  readonly state: AuthedTokenState;
  /** Per-service refresh serializer (one per client instance). */
  readonly lock: RefreshLock;
  /** `/tokens` dir override (defaults to `TOKENS_DIR` env or `/tokens`). */
  readonly tokensDir?: string;
}

/** Options for {@link authedRequest}. */
export interface AuthedRequestOptions extends AuthedRefreshContext {
  /**
   * Issues the request with the given bearer. Called up to twice (initial +
   * post-refresh retry). MUST apply the passed token as the request's bearer;
   * `authedRequest` does not set the Authorization header itself.
   */
  readonly send: (accessToken: string) => Promise<Response>;
  /** Proactively refresh when the token expires within this window (seconds). */
  readonly proactiveWithinSeconds?: number;
  /** Statuses (≥400) that trigger refresh+retry (default `[401]`; GLPI adds 400). */
  readonly authFailureStatuses?: readonly number[];
}

/** Brief re-poll for the rewritten token; covers documented virtiofs lag. */
const STALE_READ_POLL_ATTEMPTS = 5;
const STALE_READ_POLL_DELAY_MS = 100;

/**
 * Refresh the caller's token via the oauth worker, then re-read the fresh value
 * the worker wrote into `/tokens/access_token`. Mutates `state.accessToken`.
 * @param ctx - the refresh context
 */
async function refreshInto(ctx: AuthedRefreshContext): Promise<void> {
  const before = ctx.state.accessToken;
  const outcome = await refreshAccessToken({ service: ctx.service });
  const dir = ctx.tokensDir ?? process.env.TOKENS_DIR ?? '/tokens';
  let fresh = await loadToken(join(dir, 'access_token'));
  // A real refresh rewrites the file with a new value; a rate-limited noop
  // does not. If the worker says it refreshed but we still read the old token,
  // poll briefly — host-write → guest-read lag through the mount is a
  // documented phenomenon (ADR-066) — then proceed with whatever is there.
  if (!outcome.rateLimited) {
    for (let i = 0; i < STALE_READ_POLL_ATTEMPTS && fresh === before; i += 1) {
      await new Promise((r) => setTimeout(r, STALE_READ_POLL_DELAY_MS));
      fresh = await loadToken(join(dir, 'access_token'));
    }
    if (fresh === before) {
      console.warn(
        `${ts()} ${ctx.service}: access_token unchanged after refresh — possible stale mount read`
      );
    }
  }
  if (!fresh) {
    throw new Error('oauth worker reported success but access_token was not written');
  }
  ctx.state.accessToken = fresh;
}

/**
 * Execute an authenticated request with shared refresh-retry semantics.
 * @param opts - service id, mutable token state, refresh lock, and `send`
 * @returns the final {@link Response} (caller checks `response.ok`)
 * @throws {OAuthScopeMismatchError} when the IdP needs re-consent
 */
export async function authedRequest(opts: AuthedRequestOptions): Promise<Response> {
  const failureStatuses = opts.authFailureStatuses ?? DEFAULT_AUTH_FAILURE_STATUSES;
  if (failureStatuses.some((s) => s < 400)) {
    throw new Error(
      'authFailureStatuses must all be >= 400; refreshing on a 2xx/3xx is never valid'
    );
  }

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
      console.warn(
        `${ts()} ${opts.service}: proactive refresh failed, falling through to reactive path: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const response = await opts.send(opts.state.accessToken);
  if (!failureStatuses.includes(response.status)) return response;

  await refreshOnce(opts);
  return opts.send(opts.state.accessToken);
}

/**
 * Refresh under the lock, unless another caller refreshed while we waited.
 * @param ctx - the refresh context
 */
async function refreshOnce(ctx: AuthedRefreshContext): Promise<void> {
  const before = ctx.lock.generation;
  await ctx.lock.run(async () => {
    if (ctx.lock.generation !== before) return; // another caller already refreshed
    await refreshInto(ctx);
    ctx.lock.generation += 1;
  });
}

/** Options for {@link authedSdkCall}. */
export interface AuthedSdkCallOptions<T> extends AuthedRefreshContext {
  /**
   * Issues the SDK call with the given token. Called up to twice (initial +
   * post-refresh retry). MUST apply the passed token to the call.
   */
  readonly send: (accessToken: string) => Promise<T>;
  /** True when the thrown error means "token stale" → refresh + retry once. */
  readonly isAuthError: (err: unknown) => boolean;
}

/**
 * SDK-shaped sibling of {@link authedRequest} for clients that throw typed
 * errors instead of returning a `Response` (e.g. `@slack/web-api`): on an
 * auth error, refresh once via the oauth worker and retry once.
 * @param opts - refresh context plus `send` and the auth-error predicate
 * @throws {OAuthScopeMismatchError} when the IdP needs re-consent
 */
export async function authedSdkCall<T>(opts: AuthedSdkCallOptions<T>): Promise<T> {
  try {
    return await opts.send(opts.state.accessToken);
  } catch (err) {
    if (!opts.isAuthError(err)) throw err;
    await refreshOnce(opts);
    return opts.send(opts.state.accessToken);
  }
}
