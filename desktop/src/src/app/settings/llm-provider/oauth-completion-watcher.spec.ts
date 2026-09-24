import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OauthCompletionWatcher, type OauthWatchContext } from './oauth-completion-watcher';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';
import type { AuthStatusResponse, OauthSignIn } from '../../services/project-state.service';

/**
 * Drains pending non-Zone microtasks.
 * @param cycles - How many `await Promise.resolve()` ticks to drain.
 */
async function flushMicrotasks(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

/**
 * Auth-status payload with the given verdict fields set.
 * @param oauthAuthenticated - Value for the `oauth_authenticated` flag.
 * @param signIn - Optional `oauth_sign_in` verdict; omitted mirrors an older payload.
 */
function authStatus(oauthAuthenticated: boolean, signIn?: OauthSignIn): Record<string, unknown> {
  return {
    api_key_configured: false,
    oauth_authenticated: oauthAuthenticated,
    ...(signIn ? { oauth_sign_in: signIn } : {}),
    needs_anthropic_auth: true,
    provider_configured: true,
  };
}

describe('OauthCompletionWatcher', () => {
  let watcher: OauthCompletionWatcher;
  let mockTauri: MockTauriService;

  /**
   * Builds a context with probing defaults plus login/verdict call counters.
   * @param overrides - Context members to replace.
   */
  function makeContext(overrides: Partial<OauthWatchContext> = {}): {
    ctx: OauthWatchContext;
    logins: () => number;
    verdicts: () => Array<{ project: string; status: AuthStatusResponse }>;
  } {
    let loginCount = 0;
    const verdictCalls: Array<{ project: string; status: AuthStatusResponse }> = [];
    const ctx: OauthWatchContext = {
      activeProject: () => 'proj',
      lastKnown: () => 'none',
      shouldProbe: () => true,
      onLoginDetected: async () => {
        loginCount++;
      },
      onVerdict: (project, status) => {
        verdictCalls.push({ project, status });
      },
      ...overrides,
    };
    return { ctx, logins: () => loginCount, verdicts: () => verdictCalls };
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    TestBed.configureTestingModule({
      providers: [OauthCompletionWatcher, { provide: TauriService, useValue: mockTauri }],
    });
    watcher = TestBed.inject(OauthCompletionWatcher);
  });

  afterEach(() => {
    watcher.destroy();
  });

  it('checkNow fires onLoginDetected on the none→verified edge and stops the poll', async () => {
    mockTauri.invokeHandler = async () => authStatus(true);
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);
    watcher.startPoll();

    await watcher.checkNow();

    expect(logins()).toBe(1);
    expect(watcher.isPolling()).toBe(false);
  });

  it('checkNow without an attached context or active project performs no IPC', async () => {
    const invokes: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      invokes.push(cmd);
      return authStatus(true);
    };

    await watcher.checkNow();

    const noProject = makeContext({ activeProject: () => null });
    watcher.attach(noProject.ctx);
    await watcher.checkNow();

    expect(invokes).toEqual([]);
    expect(noProject.logins()).toBe(0);
  });

  it('does not fire either callback when the observed verdict matches lastKnown', async () => {
    mockTauri.invokeHandler = async () => authStatus(true);
    const { ctx, logins, verdicts } = makeContext({ lastKnown: () => 'verified' });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
    expect(verdicts()).toEqual([]);
  });

  it('calls onVerdict, not onLoginDetected, when the first observation is verified while known is pending', async () => {
    mockTauri.invokeHandler = async () => authStatus(true);
    const { ctx, logins, verdicts } = makeContext({ lastKnown: () => 'pending' });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
    expect(verdicts()).toEqual([{ project: 'proj', status: authStatus(true) }]);
  });

  it('calls onVerdict for a saved_unverified project that becomes verified (no restart)', async () => {
    mockTauri.invokeHandler = async () => authStatus(true);
    const { ctx, logins, verdicts } = makeContext({ lastKnown: () => 'saved_unverified' });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
    expect(verdicts().length).toBe(1);
  });

  it('overlapping probes fire the callback only once (in-flight guard)', async () => {
    const pendingProbe = createDeferred<unknown>();
    let firstProbe = true;
    mockTauri.invokeHandler = async () => {
      if (firstProbe) {
        firstProbe = false;
        return pendingProbe.promise;
      }
      return authStatus(true);
    };
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);

    const first = watcher.checkNow();
    const second = watcher.checkNow();
    pendingProbe.resolve(authStatus(true));
    await Promise.all([first, second]);

    expect(logins()).toBe(1);
  });

  it('drops a probe whose project changed mid-flight (stale drop, no callback)', async () => {
    let project = 'proj-a';
    mockTauri.invokeHandler = async () => {
      project = 'proj-b';
      return authStatus(true);
    };
    const { ctx, logins, verdicts } = makeContext({ activeProject: () => project });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
    expect(verdicts()).toEqual([]);
  });

  it('drops a probe that lands after the watcher was destroyed (no callback)', async () => {
    const probe = createDeferred<Record<string, unknown>>();
    mockTauri.invokeHandler = async () => probe.promise;
    const { ctx, logins, verdicts } = makeContext();
    watcher.attach(ctx);

    const checking = watcher.checkNow();
    watcher.destroy();
    probe.resolve(authStatus(true));
    await checking;

    expect(logins()).toBe(0);
    expect(verdicts()).toEqual([]);
  });

  it('swallows a failing get_auth_status and stays usable (container not up yet)', async () => {
    let fail = true;
    mockTauri.invokeHandler = async () => {
      if (fail) throw new Error('container not running');
      return authStatus(true);
    };
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);

    await watcher.checkNow();
    fail = false;
    await watcher.checkNow();

    expect(logins()).toBe(1);
  });

  it('the poll self-expires after MAX_TICKS (no infinite IPC)', () => {
    vi.useFakeTimers();
    try {
      const { ctx } = makeContext({ shouldProbe: () => false });
      watcher.attach(ctx);
      watcher.startPoll();
      expect(watcher.isPolling()).toBe(true);

      vi.advanceTimersByTime(
        (OauthCompletionWatcher.MAX_TICKS + 1) * OauthCompletionWatcher.POLL_MS
      );

      expect(watcher.isPolling()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('poll ticks probe only while shouldProbe is true', () => {
    vi.useFakeTimers();
    try {
      const invokes: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        invokes.push(cmd);
        return authStatus(false);
      };
      let probe = false;
      const { ctx } = makeContext({ shouldProbe: () => probe });
      watcher.attach(ctx);
      watcher.startPoll();

      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(invokes).toEqual([]);

      probe = true;
      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(invokes).toEqual(['get_auth_status']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the poll stops itself once lastKnown reports verified', () => {
    vi.useFakeTimers();
    try {
      let known: OauthSignIn = 'none';
      const { ctx } = makeContext({ lastKnown: () => known, shouldProbe: () => false });
      watcher.attach(ctx);
      watcher.startPoll();

      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(watcher.isPolling()).toBe(true);

      known = 'verified';
      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(watcher.isPolling()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the poll keeps running while lastKnown is saved_unverified', () => {
    vi.useFakeTimers();
    try {
      const { ctx } = makeContext({
        lastKnown: () => 'saved_unverified',
        shouldProbe: () => false,
      });
      watcher.attach(ctx);
      watcher.startPoll();

      vi.advanceTimersByTime(10 * OauthCompletionWatcher.POLL_MS);

      expect(watcher.isPolling()).toBe(true); // well short of tick exhaustion
    } finally {
      vi.useRealTimers();
    }
  });

  it('startPoll restarts an expired poll with a fresh tick budget', () => {
    vi.useFakeTimers();
    try {
      const { ctx } = makeContext({ shouldProbe: () => false });
      watcher.attach(ctx);
      watcher.startPoll();
      vi.advanceTimersByTime(
        (OauthCompletionWatcher.MAX_TICKS + 1) * OauthCompletionWatcher.POLL_MS
      );
      expect(watcher.isPolling()).toBe(false);

      watcher.startPoll();
      vi.advanceTimersByTime(
        (OauthCompletionWatcher.MAX_TICKS - 1) * OauthCompletionWatcher.POLL_MS
      );
      expect(watcher.isPolling()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a window_focused event forces an immediate probe', async () => {
    const invokes: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      invokes.push(cmd);
      return authStatus(true);
    };
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);
    watcher.watchWindowFocus();
    await flushMicrotasks();

    mockTauri.dispatchEvent('window_focused', undefined);
    await flushMicrotasks();

    expect(invokes).toContain('get_auth_status');
    expect(logins()).toBe(1);
  });

  it('watchWindowFocus subscribes at most once', async () => {
    const listenSpy = vi.spyOn(mockTauri, 'listen');
    watcher.attach(makeContext().ctx);

    watcher.watchWindowFocus();
    watcher.watchWindowFocus();
    await flushMicrotasks();

    expect(listenSpy).toHaveBeenCalledTimes(1);
  });

  it('survives listen() rejection outside the desktop context', async () => {
    vi.spyOn(mockTauri, 'listen').mockRejectedValue(new Error('not in tauri'));
    watcher.attach(makeContext().ctx);

    watcher.watchWindowFocus();
    await flushMicrotasks();

    watcher.destroy();
    expect(watcher.isPolling()).toBe(false);
  });

  it('destroy stops the poll and releases the focus listener', async () => {
    watcher.attach(makeContext().ctx);
    watcher.startPoll();
    watcher.watchWindowFocus();
    await flushMicrotasks();
    expect(mockTauri.listenHandlers['window_focused']).toBeDefined();

    watcher.destroy();

    expect(watcher.isPolling()).toBe(false);
    expect(mockTauri.listenHandlers['window_focused']).toBeUndefined();
  });

  it('a focus registration settling after destroy is released immediately', async () => {
    watcher.attach(makeContext().ctx);
    watcher.watchWindowFocus();
    watcher.destroy();
    await flushMicrotasks();

    expect(mockTauri.listenHandlers['window_focused']).toBeUndefined();
  });

  it('ngOnDestroy tears down like destroy (DI-driven teardown)', () => {
    watcher.attach(makeContext().ctx);
    watcher.startPoll();

    watcher.ngOnDestroy();

    expect(watcher.isPolling()).toBe(false);
  });

  it('starts no poll once destroyed (a logout finishing after its form is gone)', () => {
    watcher.attach(makeContext().ctx);
    watcher.destroy();

    watcher.startPoll();

    expect(watcher.isPolling()).toBe(false);
  });
});
