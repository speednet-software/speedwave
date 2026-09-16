import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryAsync } from './retry.js';

describe('retryAsync', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns result immediately when fn succeeds on first call', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retryAsync(fn, { maxRetries: 3, label: 'test' });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries when fn returns null and succeeds on third attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('success');

    const promise = retryAsync(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      label: 'null-retry',
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries when fn throws an Error and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({ data: 42 });

    const promise = retryAsync(fn, {
      maxRetries: 3,
      baseDelayMs: 50,
      label: 'dns-retry',
    });

    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toEqual({ data: 42 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting retries when fn always returns null', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi.fn().mockResolvedValue(null);

    const promise = retryAsync(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
      label: 'exhaust-null',
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns null (does not propagate) when fn throws on all attempts', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const promise = retryAsync(fn, {
      maxRetries: 2,
      baseDelayMs: 50,
      label: 'exhaust-throw',
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('handles mixed throw-then-null-then-success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue('recovered');

    const promise = retryAsync(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      label: 'mixed',
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom maxRetries=1', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi.fn().mockResolvedValue(null);

    const promise = retryAsync(fn, {
      maxRetries: 1,
      baseDelayMs: 100,
      label: 'custom-opts',
    });

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when maxRetries=0', async () => {
    const fn = vi.fn().mockResolvedValue(null);

    const result = await retryAsync(fn, { maxRetries: 0, label: 'no-retry' });

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when maxRetries=0 and fn throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await retryAsync(fn, { maxRetries: 0, label: 'no-retry-throw' });

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff (2s, 4s, 8s pattern)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fn = vi.fn().mockResolvedValue(null);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const promise = retryAsync(fn, {
      maxRetries: 3,
      baseDelayMs: 2000,
      label: 'backoff-test',
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);

    await promise;

    const sleepCalls = setTimeoutSpy.mock.calls
      .filter(([, ms]) => typeof ms === 'number' && ms >= 2000)
      .map(([, ms]) => ms);

    expect(sleepCalls).toEqual([2000, 4000, 8000]);
  });

  describe('jitter', () => {
    it('adds zero jitter when Math.random returns 0', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const fn = vi.fn().mockResolvedValue(null);
      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 1000,
        label: 'jitter-zero',
      });

      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      const sleepDelays = setTimeoutSpy.mock.calls
        .filter(([, ms]) => typeof ms === 'number' && ms >= 1000)
        .map(([, ms]) => ms);
      expect(sleepDelays).toContain(1000);
    });

    it('adds maximum jitter when Math.random returns 1', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const fn = vi.fn().mockResolvedValue(null);
      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 1000,
        label: 'jitter-max',
      });

      await vi.advanceTimersByTimeAsync(1300);
      await promise;

      const sleepDelays = setTimeoutSpy.mock.calls
        .filter(([, ms]) => typeof ms === 'number' && ms >= 1000)
        .map(([, ms]) => ms);
      expect(sleepDelays).toContain(1300);
    });

    it('adds proportional jitter when Math.random returns 0.5', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const fn = vi.fn().mockResolvedValue(null);
      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 1000,
        label: 'jitter-half',
      });

      await vi.advanceTimersByTimeAsync(1150);
      await promise;

      const sleepDelays = setTimeoutSpy.mock.calls
        .filter(([, ms]) => typeof ms === 'number' && ms >= 1000)
        .map(([, ms]) => ms);
      expect(sleepDelays).toContain(1150);
    });
  });

  it('caps delay at maxDelayMs even with high attempt count', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi.fn().mockResolvedValue(null);
    const promise = retryAsync(fn, {
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 5000,
      label: 'cap-test',
    });

    for (const ms of [2000, 4000, 5000, 5000, 5000]) {
      await vi.advanceTimersByTimeAsync(ms);
    }

    await promise;

    const sleepDelays = setTimeoutSpy.mock.calls
      .filter(([, ms]) => typeof ms === 'number' && ms >= 2000)
      .map(([, ms]) => ms);

    for (const d of sleepDelays) {
      expect(d).toBeLessThanOrEqual(5000);
    }
    expect(sleepDelays.filter((d) => d === 5000).length).toBeGreaterThanOrEqual(3);
  });

  describe('logging', () => {
    it('logs retry attempts with the label', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const fn = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('ok');

      const promise = retryAsync(fn, {
        maxRetries: 2,
        baseDelayMs: 50,
        label: 'MyLabel',
      });

      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((args) =>
        args.join(' ')
      );
      expect(logCalls.some((msg) => msg.includes('MyLabel'))).toBe(true);
    });

    it('warns on retry exhaustion with the label', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const fn = vi.fn().mockResolvedValue(null);

      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 50,
        label: 'ExhaustLabel',
      });

      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) =>
        args.join(' ')
      );
      expect(warnCalls.some((msg) => msg.includes('ExhaustLabel'))).toBe(true);
      expect(warnCalls.some((msg) => msg.includes('exhausted'))).toBe(true);
    });

    it('warns with error message when fn throws', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue('ok');

      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 50,
        label: 'err-log',
      });

      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) =>
        args.join(' ')
      );
      expect(warnCalls.some((msg) => msg.includes('connection refused'))).toBe(true);
    });

    it('converts non-Error thrown values to string in warning', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const fn = vi
        .fn()
        .mockRejectedValueOnce('plain string failure')
        .mockResolvedValue('recovered');

      const promise = retryAsync(fn, {
        maxRetries: 1,
        baseDelayMs: 50,
        label: 'non-error-throw',
      });

      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;

      expect(result).toBe('recovered');

      const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((args) =>
        args.join(' ')
      );
      expect(warnCalls.some((msg) => msg.includes('plain string failure'))).toBe(true);
    });
  });
});
