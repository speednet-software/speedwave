/**
 * SSOT reactive refresh-retry every OAuth consumer shares: wait for the host to rewrite
 * `/tokens/access_token` and retry on an auth-failure status. See ADR-069 (plugins).
 */
import { join } from 'node:path';
import { loadToken } from './security.js';
import { ts } from './logger.js';
import { TIMEOUTS } from './timeouts.js';
import { accessTokenExpiresWithin, refreshFailure } from './oauth-client.js';

/** RFC 6750 status for a stale token; GLPI also misuses 400, so it's opt-in. */
const DEFAULT_AUTH_FAILURE_STATUSES = [401];

/**
 * Serializes refreshes so concurrent failures trigger one refresh, not N.
 * The `generation` counter lets callers detect "someone already refreshed".
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
  /** Service id (e.g. `sharepoint`, `slack`); names the service in refresh failure messages. */
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
   * Issues the request with the given bearer (called up to twice: initial + post-refresh retry).
   * MUST apply the passed token as the request's bearer; this fn does not set Authorization itself.
   */
  readonly send: (accessToken: string) => Promise<Response>;
  /** Proactively refresh when the token expires within this window (seconds). */
  readonly proactiveWithinSeconds?: number;
  /** Statuses (≥400) that trigger refresh+retry (default `[401]`; GLPI adds 400). */
  readonly authFailureStatuses?: readonly number[];
}

const TOKEN_POLL_INTERVAL_MS = 500;

/**
 * Wait for the host to rewrite `/tokens/access_token` (up to `TIMEOUTS.TOKEN_REFRESH_MS`) and
 * adopt it. Mutates `state.accessToken`.
 * @param ctx - Refresh context (service id, token state, tokens dir override).
 * @param before - the token that was rejected.
 * @throws {OAuthRefreshError} when the token is still unchanged, worded by `refresh_status`.
 */
async function refreshInto(ctx: AuthedRefreshContext, before: string): Promise<void> {
  const dir = tokensDirOf(ctx);
  let fresh = await loadToken(join(dir, 'access_token'));
  for (
    let waited = 0;
    isUnchanged(fresh, before) && waited < TIMEOUTS.TOKEN_REFRESH_MS;
    waited += TOKEN_POLL_INTERVAL_MS
  ) {
    await new Promise((r) => setTimeout(r, TOKEN_POLL_INTERVAL_MS));
    fresh = await loadToken(join(dir, 'access_token'));
  }
  if (isUnchanged(fresh, before)) {
    throw await refreshFailure(ctx.service, dir);
  }
  ctx.state.accessToken = fresh;
}

async function adoptRewrittenToken(ctx: AuthedRefreshContext): Promise<void> {
  const fresh = await loadToken(join(tokensDirOf(ctx), 'access_token'));
  if (!isUnchanged(fresh, ctx.state.accessToken)) {
    ctx.state.accessToken = fresh;
  }
}

function tokensDirOf(ctx: AuthedRefreshContext): string {
  return ctx.tokensDir ?? process.env.TOKENS_DIR ?? '/tokens';
}

function isUnchanged(fresh: string, before: string): boolean {
  return fresh === '' || fresh === before;
}

/**
 * Execute an authenticated request with shared refresh-retry semantics.
 * @param opts - Request options (service, token state, lock, send callback, retry thresholds).
 * @throws {OAuthRefreshError} when the host did not rewrite the token within the wait.
 */
export async function authedRequest(opts: AuthedRequestOptions): Promise<Response> {
  const failureStatuses = opts.authFailureStatuses ?? DEFAULT_AUTH_FAILURE_STATUSES;
  if (failureStatuses.some((s) => s < 400)) {
    throw new Error(
      'authFailureStatuses must all be >= 400; refreshing on a 2xx/3xx is never valid'
    );
  }

  if (
    typeof opts.proactiveWithinSeconds === 'number' &&
    accessTokenExpiresWithin(opts.state.accessToken, opts.proactiveWithinSeconds)
  ) {
    try {
      await adoptRewrittenToken(opts);
    } catch (err) {
      console.warn(
        `${ts()} ${opts.service}: reading the rewritten token failed, falling through to reactive path: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const sent = opts.state.accessToken;
  const response = await opts.send(sent);
  if (!failureStatuses.includes(response.status)) return response;

  await refreshOnce(opts, sent);
  return opts.send(opts.state.accessToken);
}

/**
 * Refresh under the lock, unless another caller already replaced the rejected token.
 * @param ctx - the refresh context
 * @param sent - the token the failed call was sent with
 */
async function refreshOnce(ctx: AuthedRefreshContext, sent: string): Promise<void> {
  if (ctx.state.accessToken !== sent) return;
  const before = ctx.lock.generation;
  await ctx.lock.run(async () => {
    if (ctx.lock.generation !== before || ctx.state.accessToken !== sent) return;
    await refreshInto(ctx, sent);
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
 * SDK sibling of {@link authedRequest} for clients throwing typed errors (e.g. `@slack/web-api`):
 * wait for the rewritten token on auth error and retry.
 * @param opts - Call options (service, token state, lock, send callback, isAuthError predicate).
 * @throws {OAuthRefreshError} when the host did not rewrite the token within the wait.
 */
export async function authedSdkCall<T>(opts: AuthedSdkCallOptions<T>): Promise<T> {
  const sent = opts.state.accessToken;
  try {
    return await opts.send(sent);
  } catch (err) {
    if (!opts.isAuthError(err)) throw err;
    await refreshOnce(opts, sent);
    return opts.send(opts.state.accessToken);
  }
}
