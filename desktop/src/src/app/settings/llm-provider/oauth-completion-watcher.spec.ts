import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OauthCompletionWatcher, type OauthWatchContext } from './oauth-completion-watcher';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

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
 * Auth-status payload with the OAuth flag set as requested.
 * @param oauthAuthenticated - Value for the `oauth_authenticated` flag.
 */
function authStatus(oauthAuthenticated: boolean): Record<string, unknown> {
  return {
    api_key_configured: false,
    oauth_authenticated: oauthAuthenticated,
    needs_anthropic_auth: true,
    provider_configured: true,
  };
}

describe('OauthCompletionWatcher', () => {
  let watcher: OauthCompletionWatcher;
  let mockTauri: MockTauriService;

  /**
   * Builds a context with probing defaults and a login-callback counter.
   * @param overrides - Context members to replace.
   */
  function makeContext(overrides: Partial<OauthWatchContext> = {}): {
    ctx: OauthWatchContext;
    logins: () => number;
  } {
    let count = 0;
    const ctx: OauthWatchContext = {
      activeProject: () => 'proj',
      isAuthenticated: () => false,
      shouldProbe: () => true,
      onLoginDetected: async () => {
        count++;
      },
      ...overrides,
    };
    return { ctx, logins: () => count };
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

  it('checkNow fires onLoginDetected on the credentials false→true edge and stops the poll', async () => {
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

    await watcher.checkNow(); // never attached

    const noProject = makeContext({ activeProject: () => null });
    watcher.attach(noProject.ctx);
    await watcher.checkNow();

    expect(invokes).toEqual([]);
    expect(noProject.logins()).toBe(0);
  });

  it('does not fire when credentials were already present (no false→true edge)', async () => {
    mockTauri.invokeHandler = async () => authStatus(true);
    const { ctx, logins } = makeContext({ isAuthenticated: () => true });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
  });

  it('overlapping probes fire the callback only once (in-flight guard)', async () => {
    // A slow get_auth_status must not let a second probe pass the same
    // false→true edge and fire a duplicate login callback.
    let release: (v: unknown) => void = () => {};
    let firstProbe = true;
    mockTauri.invokeHandler = async () => {
      if (firstProbe) {
        firstProbe = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return authStatus(true);
    };
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);

    const first = watcher.checkNow();
    const second = watcher.checkNow(); // overlaps while the first probe hangs
    release(authStatus(true));
    await Promise.all([first, second]);

    expect(logins()).toBe(1);
  });

  it('drops a probe whose project changed mid-flight (stale drop, no callback)', async () => {
    let project = 'proj-a';
    mockTauri.invokeHandler = async () => {
      // Simulate the user switching projects while this probe is in flight.
      project = 'proj-b';
      return authStatus(true);
    };
    const { ctx, logins } = makeContext({ activeProject: () => project });
    watcher.attach(ctx);

    await watcher.checkNow();

    expect(logins()).toBe(0);
  });

  it('swallows a failing get_auth_status and stays usable (container not up yet)', async () => {
    let fail = true;
    mockTauri.invokeHandler = async () => {
      if (fail) throw new Error('container not running');
      return authStatus(true);
    };
    const { ctx, logins } = makeContext();
    watcher.attach(ctx);

    await watcher.checkNow(); // rejected — must not throw
    fail = false;
    await watcher.checkNow(); // in-flight guard released — next probe works

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
      expect(invokes).toEqual([]); // gated tick skips the IPC

      probe = true;
      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(invokes).toEqual(['get_auth_status']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the poll stops itself once the context reports authenticated', () => {
    vi.useFakeTimers();
    try {
      let authed = false;
      const { ctx } = makeContext({ isAuthenticated: () => authed, shouldProbe: () => false });
      watcher.attach(ctx);
      watcher.startPoll();

      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(watcher.isPolling()).toBe(true);

      authed = true;
      vi.advanceTimersByTime(OauthCompletionWatcher.POLL_MS);
      expect(watcher.isPolling()).toBe(false);
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
      // Well past the previous expiry point — the budget was reset.
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

    watcher.destroy(); // still safe with no listener registered
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
    watcher.destroy(); // before the listen promise settles
    await flushMicrotasks();

    expect(mockTauri.listenHandlers['window_focused']).toBeUndefined();
  });

  it('ngOnDestroy tears down like destroy (DI-driven teardown)', () => {
    watcher.attach(makeContext().ctx);
    watcher.startPoll();

    watcher.ngOnDestroy();

    expect(watcher.isPolling()).toBe(false);
  });
});
