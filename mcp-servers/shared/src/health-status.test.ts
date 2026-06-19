import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ConnectionStatusTracker,
  makeStandardHealthCheck,
  backgroundConnectionTest,
  DEFAULT_WARMUP_MS,
} from './health-status.js';

describe('ConnectionStatusTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in unknown state with no error', () => {
    const t = new ConnectionStatusTracker();
    expect(t.getStatus()).toBe('unknown');
    expect(t.getError()).toBeNull();
  });

  it('transitions to ok via setOk and clears prior error', () => {
    const t = new ConnectionStatusTracker();
    t.setFailed(new Error('boom'));
    t.setOk();
    expect(t.getStatus()).toBe('ok');
    expect(t.getError()).toBeNull();
  });

  it('captures Error.message on setFailed', () => {
    const t = new ConnectionStatusTracker();
    t.setFailed(new Error('boom'));
    expect(t.getStatus()).toBe('failed');
    expect(t.getError()).toBe('boom');
  });

  it('captures String(value) when setFailed receives non-Error', () => {
    const t = new ConnectionStatusTracker();
    t.setFailed('plain-string-error');
    expect(t.getError()).toBe('plain-string-error');
  });

  it('isInWarmup returns true while unknown and within window', () => {
    const t = new ConnectionStatusTracker(1_000);
    expect(t.isInWarmup()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(t.isInWarmup()).toBe(true);
  });

  it('isInWarmup returns false once window elapses', () => {
    const t = new ConnectionStatusTracker(1_000);
    vi.advanceTimersByTime(1_001);
    expect(t.isInWarmup()).toBe(false);
  });

  it('isInWarmup returns false once status is ok even within window', () => {
    const t = new ConnectionStatusTracker(1_000);
    t.setOk();
    expect(t.isInWarmup()).toBe(false);
  });

  it('isInWarmup returns false once status is failed even within window', () => {
    const t = new ConnectionStatusTracker(1_000);
    t.setFailed(new Error('boom'));
    expect(t.isInWarmup()).toBe(false);
  });

  it('reset returns to unknown with fresh warm-up window', () => {
    const t = new ConnectionStatusTracker(500);
    t.setOk();
    vi.advanceTimersByTime(1_000);
    t.reset(500);
    expect(t.getStatus()).toBe('unknown');
    expect(t.getError()).toBeNull();
    expect(t.isInWarmup()).toBe(true);
    vi.advanceTimersByTime(501);
    expect(t.isInWarmup()).toBe(false);
  });

  it('getHealth returns shared HealthStatus snapshot', () => {
    const t = new ConnectionStatusTracker();
    expect(t.getHealth()).toEqual({ connection: 'unknown', connectionError: null });
    t.setFailed(new Error('boom'));
    expect(t.getHealth()).toEqual({ connection: 'failed', connectionError: 'boom' });
    t.setOk();
    expect(t.getHealth()).toEqual({ connection: 'ok', connectionError: null });
  });

  it('uses DEFAULT_WARMUP_MS when no warmup specified', () => {
    const t = new ConnectionStatusTracker();
    expect(t.isInWarmup()).toBe(true);
    vi.advanceTimersByTime(DEFAULT_WARMUP_MS - 1);
    expect(t.isInWarmup()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(t.isInWarmup()).toBe(false);
  });
});

describe('makeStandardHealthCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves without throwing when status is ok', async () => {
    const t = new ConnectionStatusTracker();
    t.setOk();
    const hc = makeStandardHealthCheck(t, 'TestService');
    await expect(hc()).resolves.toBeUndefined();
  });

  it('throws with connection error when status is failed', async () => {
    const t = new ConnectionStatusTracker();
    t.setFailed(new Error('unauthorized'));
    const hc = makeStandardHealthCheck(t, 'TestService');
    await expect(hc()).rejects.toThrow('TestService connection failed: unauthorized');
  });

  it('throws "not configured" when status is unknown after warm-up', async () => {
    const t = new ConnectionStatusTracker(1_000);
    vi.advanceTimersByTime(1_001);
    const hc = makeStandardHealthCheck(t, 'TestService');
    await expect(hc()).rejects.toThrow('TestService not configured');
  });

  it('does not throw when status is unknown during warm-up', async () => {
    const t = new ConnectionStatusTracker(1_000);
    const hc = makeStandardHealthCheck(t, 'TestService');
    await expect(hc()).resolves.toBeUndefined();
  });

  it('throws with generic error message when failed but no error captured', async () => {
    const t = new ConnectionStatusTracker();
    t.setFailed('');
    const hc = makeStandardHealthCheck(t, 'TestService');
    // empty-string error appears in the message (`??` keeps falsy strings).
    await expect(hc()).rejects.toThrow('TestService connection failed:');
  });
});

describe('backgroundConnectionTest', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks tracker ok when test resolves', async () => {
    const t = new ConnectionStatusTracker();
    const test = vi.fn().mockResolvedValue(undefined);
    backgroundConnectionTest(t, test, 'TestService');
    await vi.waitFor(() => expect(t.getStatus()).toBe('ok'));
    expect(test).toHaveBeenCalledTimes(1);
  });

  it('marks tracker failed when test rejects', async () => {
    const t = new ConnectionStatusTracker();
    const test = vi.fn().mockRejectedValue(new Error('boom'));
    backgroundConnectionTest(t, test, 'TestService');
    await vi.waitFor(() => expect(t.getStatus()).toBe('failed'));
    expect(t.getError()).toBe('boom');
  });

  it('logs warning when test rejects, with service name and error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new ConnectionStatusTracker();
    backgroundConnectionTest(t, () => Promise.reject(new Error('boom')), 'TestService');
    await vi.waitFor(() => expect(t.getStatus()).toBe('failed'));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('TestService');
    expect(msg).toContain('boom');
  });

  it('does not block the caller', () => {
    const t = new ConnectionStatusTracker();
    const start = Date.now();
    backgroundConnectionTest(
      t,
      () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      'SlowService'
    );
    // backgroundConnectionTest returns synchronously even with a 60 s test.
    expect(Date.now() - start).toBeLessThan(50);
  });
});
