/**
 * Promise memoization: caches success indefinitely, retries on rejection.
 * @module shared/promise-memo
 */

/** Options for {@link memoizedPromise}. */
export interface MemoizedPromiseOptions<T> {
  /** The async operation to memoize. Called at most once per cache miss. */
  fetch: () => Promise<T>;
  /** Resolve with {@link timeoutValue} after this many ms if fetch still pending. */
  timeoutMs?: number;
  /** Value returned on timeout. Required when `timeoutMs` is set. */
  timeoutValue?: T;
}

/**
 * Build a memoized async getter.
 * @param opts - Memoization options (see {@link MemoizedPromiseOptions}).
 */
export function memoizedPromise<T>(opts: MemoizedPromiseOptions<T>): () => Promise<T> {
  let cache: Promise<T> | null = null;
  return () => {
    if (cache) return cache;
    const underlying = opts.fetch().catch((err) => {
      // Clear cache so the next call retries.
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
