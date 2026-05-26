import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoizedPromise } from './promise-memo.js';

describe('memoizedPromise', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the same promise to concurrent callers (single fetch)', async () => {
    const fetch = vi.fn().mockResolvedValue('value');
    const get = memoizedPromise<string>({ fetch });

    const p1 = get();
    const p2 = get();
    expect(p1).toBe(p2);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(p1).resolves.toBe('value');
  });

  it('memoizes successful results across sequential calls', async () => {
    const fetch = vi.fn().mockResolvedValue('value');
    const get = memoizedPromise<string>({ fetch });

    await expect(get()).resolves.toBe('value');
    await expect(get()).resolves.toBe('value');
    await expect(get()).resolves.toBe('value');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clears cache on rejection so next call retries', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('first-fail'))
      .mockResolvedValue('second-ok');
    const get = memoizedPromise<string>({ fetch });

    await expect(get()).rejects.toThrow('first-fail');
    await expect(get()).resolves.toBe('second-ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves with timeoutValue when fetch exceeds timeoutMs', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const get = memoizedPromise<string | null>({
      fetch,
      timeoutMs: 100,
      timeoutValue: null,
    });

    const promise = get();
    await vi.advanceTimersByTimeAsync(101);
    await expect(promise).resolves.toBeNull();
  });

  it('uses underlying result when fetch finishes before timeout', async () => {
    const fetch = vi.fn().mockResolvedValue('fast');
    const get = memoizedPromise<string | null>({
      fetch,
      timeoutMs: 1_000,
      timeoutValue: null,
    });

    await expect(get()).resolves.toBe('fast');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch on subsequent calls after timeout resolution', async () => {
    // After a timeout, the underlying promise is still pending. Subsequent
    // calls during that pending window share the cached race-promise.
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const get = memoizedPromise<string | null>({
      fetch,
      timeoutMs: 100,
      timeoutValue: null,
    });

    const p1 = get();
    await vi.advanceTimersByTimeAsync(101);
    await expect(p1).resolves.toBeNull();
    // Second call within the pending window returns the same cached race.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('underlying rejection still clears cache when running alongside a timeout', async () => {
    let rejectFn!: (err: Error) => void;
    const fetch = vi.fn().mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFn = reject;
        })
    );
    const get = memoizedPromise<string | null>({
      fetch,
      timeoutMs: 10_000,
      timeoutValue: null,
    });

    const p = get();
    rejectFn(new Error('boom'));
    await expect(p).rejects.toThrow('boom');

    // Cache cleared by the rejection handler — next call triggers a fresh fetch.
    const fetch2 = vi.fn().mockResolvedValue('second');
    // Replace implementation so the next call uses the new one.
    fetch.mockImplementation(fetch2);
    await expect(get()).resolves.toBe('second');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
