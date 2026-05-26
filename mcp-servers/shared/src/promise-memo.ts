/**
 * Promise memoization with cache-on-failure.
 *
 * Replaces ad-hoc `private _xxxPromise: Promise<T> | null = null` fields in
 * workers (e.g. Redmine `_scopedProjectIdPromise`, SharePoint
 * `_resolvedSiteIdPromise`, Redmine `_projectNamePromise`).
 *
 * Successful results are cached indefinitely. On rejection, the cache is
 * cleared so the next call retries. An optional bounded timeout via
 * `Promise.race` lets callers cap wait time and fall back to a default value.
 * @module shared/promise-memo
 */

/** Options for {@link memoizedPromise}. */
export interface MemoizedPromiseOptions<T> {
  /** The async operation to memoize. Called at most once per cache miss. */
  fetch: () => Promise<T>;
  /**
   * Bound the time callers wait for the underlying fetch. When set, the
   * returned promise resolves with {@link timeoutValue} after this many
   * milliseconds even if the underlying fetch is still pending. The
   * underlying fetch continues to populate the cache when it eventually
   * settles, so subsequent calls benefit from the eventual result.
   */
  timeoutMs?: number;
  /**
   * Value returned on timeout. Required when `timeoutMs` is set. Use `null`
   * (with `T extends ... | null`) when callers should treat timeout as
   * "value not yet available".
   */
  timeoutValue?: T;
}

/**
 * Build a memoized async getter.
 *
 * Usage:
 * ```ts
 * private getProjectName = memoizedPromise<string | null>({
 *   fetch: () => this.client.get('/project').then(r => r.data.name),
 *   timeoutMs: 5_000,
 *   timeoutValue: null,
 * });
 * ```
 *
 * Subsequent calls during an in-flight fetch share the same promise; calls
 * after a rejection trigger a fresh fetch.
 * @param opts - Memoization options (see {@link MemoizedPromiseOptions}).
 */
export function memoizedPromise<T>(opts: MemoizedPromiseOptions<T>): () => Promise<T> {
  let cache: Promise<T> | null = null;
  return () => {
    if (cache) return cache;
    const underlying = opts.fetch().catch((err) => {
      // Clear cache so the next call retries. Re-throw so callers see the
      // rejection (the timeout-race path below converts it to timeoutValue
      // only when timeoutMs is set).
      cache = null;
      throw err;
    });
    if (opts.timeoutMs !== undefined) {
      cache = Promise.race<T>([
        underlying,
        new Promise<T>((resolve) =>
          setTimeout(() => resolve(opts.timeoutValue as T), opts.timeoutMs)
        ),
      ]);
    } else {
      cache = underlying;
    }
    return cache;
  };
}
