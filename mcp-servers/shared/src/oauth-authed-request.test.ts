import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the two I/O collaborators so the tests exercise the helper's control
// flow (which statuses refresh, retry-once, proactive, single-flight) without
// touching the network or disk.
const refreshAccessToken = vi.fn();
const loadToken = vi.fn();
const accessTokenExpiresWithin = vi.fn();

class OAuthScopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthScopeMismatchError';
  }
}

vi.mock('./oauth-client.js', () => ({
  refreshAccessToken: (...a: unknown[]) => refreshAccessToken(...a),
  accessTokenExpiresWithin: (...a: unknown[]) => accessTokenExpiresWithin(...a),
  OAuthScopeMismatchError,
}));
vi.mock('./security.js', () => ({
  loadToken: (...a: unknown[]) => loadToken(...a),
}));

const { authedRequest, authedSdkCall, RefreshLock } = await import('./oauth-authed-request.js');

function resp(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe('authedRequest', () => {
  beforeEach(() => {
    refreshAccessToken.mockReset();
    loadToken.mockReset();
    accessTokenExpiresWithin.mockReset();
    accessTokenExpiresWithin.mockReturnValue(false); // no proactive refresh by default
    refreshAccessToken.mockResolvedValue({ expiresIn: 3600, grantedScopes: [] });
    loadToken.mockResolvedValue('fresh-token');
  });

  function baseOpts(send: (t: string) => Promise<Response>) {
    return { service: 'glpi', state: { accessToken: 'old-token' }, lock: new RefreshLock(), send };
  }

  // --- Happy path: a 2xx never refreshes ---
  it('returns a 200 without refreshing', async () => {
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- 401: refresh + retry once with the fresh token ---
  it('refreshes and retries once on 401', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, 'old-token');
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  // --- 400 is NOT an auth failure by default (RFC 6750) — never refresh ---
  it('does NOT refresh on a 400 by default', async () => {
    const send = vi.fn().mockResolvedValue(resp(400));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- 400 IS an auth failure when opted in (GLPI expired-token quirk) ---
  it('refreshes and retries on 400 when authFailureStatuses includes it', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(400)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest({ ...baseOpts(send), authFailureStatuses: [400, 401] });
    expect(out.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  // --- 5xx: server fault, NOT a stale token — never refresh ---
  it('does NOT refresh on a 5xx (server error)', async () => {
    const send = vi.fn().mockResolvedValue(resp(503));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- 403/404: not auth-failure statuses — never refresh ---
  it('does NOT refresh on a 403 or 404', async () => {
    for (const status of [403, 404]) {
      refreshAccessToken.mockClear();
      const send = vi.fn().mockResolvedValue(resp(status));
      const out = await authedRequest(baseOpts(send));
      expect(out.status).toBe(status);
      expect(refreshAccessToken).not.toHaveBeenCalled();
    }
  });

  // --- Retry exactly once: a second 401 is returned, not looped ---
  it('retries exactly once — a persistent 401 is returned, not looped', async () => {
    const send = vi.fn().mockResolvedValue(resp(401));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  // --- Proactive: token near expiry refreshes BEFORE the request ---
  it('proactively refreshes when the token is near expiry', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('fresh-token'); // refreshed before send
  });

  // --- Proactive failure is non-fatal: fall through with the current token, but log it ---
  it('falls through to the request when a proactive refresh fails', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    refreshAccessToken.mockRejectedValue(new Error('worker_unreachable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledWith('old-token'); // kept the pre-refresh token
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proactive refresh failed'));
    warn.mockRestore();
  });

  // --- Proactive scope-mismatch cannot self-heal — propagate, no request ---
  it('propagates a scope mismatch from proactive refresh without sending', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    refreshAccessToken.mockRejectedValue(new OAuthScopeMismatchError('scope missing'));
    const send = vi.fn();
    await expect(
      authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 })
    ).rejects.toBeInstanceOf(OAuthScopeMismatchError);
    expect(send).not.toHaveBeenCalled();
  });

  // --- State transition: state.accessToken is updated after a refresh ---
  it('updates state.accessToken after a refresh', async () => {
    const opts = baseOpts(
      vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200))
    );
    await authedRequest(opts);
    expect(opts.state.accessToken).toBe('fresh-token');
  });

  // --- Single-flight: concurrent failures trigger ONE refresh, not N ---
  it('serializes concurrent refreshes — two parallel 401s refresh once', async () => {
    const lock = new RefreshLock();
    const state = { accessToken: 'old-token' };
    let refreshes = 0;
    refreshAccessToken.mockImplementation(async () => {
      refreshes += 1;
      return { expiresIn: 3600, grantedScopes: [] };
    });
    const mkSend = () => vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const [a, b] = await Promise.all([
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshes).toBe(1); // generation guard, not token-value comparison
  });

  // --- Single-flight holds even if the refreshed token is IDENTICAL ---
  it('single-flights via generation even when the new token equals the old', async () => {
    const lock = new RefreshLock();
    const state = { accessToken: 'same-token' };
    loadToken.mockResolvedValue('same-token'); // worker re-issues an identical token
    let refreshes = 0;
    refreshAccessToken.mockImplementation(async () => {
      refreshes += 1;
      return { expiresIn: 3600, grantedScopes: [] };
    });
    const mkSend = () => vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    await Promise.all([
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
    ]);
    expect(refreshes).toBe(1); // a string-identity guard would wrongly refresh twice here
  });

  // --- Proactive window provided but token fresh — no proactive refresh ---
  it('does NOT proactively refresh when the token is not near expiry', async () => {
    accessTokenExpiresWithin.mockReturnValue(false);
    const send = vi.fn().mockResolvedValue(resp(200));
    await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- Chained: proactive refresh succeeds, server still 401s → reactive refresh ---
  it('refreshes reactively after a proactive refresh when the server still 401s', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(refreshAccessToken).toHaveBeenCalledTimes(2); // proactive + reactive
  });

  // --- Guard: a sub-400 status in authFailureStatuses is rejected ---
  it('rejects authFailureStatuses containing a status below 400', async () => {
    const send = vi.fn().mockResolvedValue(resp(200));
    await expect(
      authedRequest({ ...baseOpts(send), authFailureStatuses: [200, 401] })
    ).rejects.toThrow(/>= 400/);
  });

  // --- Error path: refresh failure propagates ---
  it('propagates a refresh failure on 401', async () => {
    refreshAccessToken.mockRejectedValue(new Error('worker_unreachable'));
    const send = vi.fn().mockResolvedValue(resp(401));
    await expect(authedRequest(baseOpts(send))).rejects.toThrow('worker_unreachable');
  });

  // --- Error path: oauth worker "succeeds" but writes no token ---
  it('throws when the worker reports success but writes no access_token', async () => {
    loadToken.mockResolvedValue('');
    const send = vi.fn().mockResolvedValue(resp(401));
    await expect(authedRequest(baseOpts(send))).rejects.toThrow(/access_token was not written/);
  });

  // --- Stale-mount mitigation: rate-limited noop must NOT poll ---
  it('skips the stale-read poll when the worker reports a rate-limited noop', async () => {
    refreshAccessToken.mockResolvedValue({ expiresIn: 600, grantedScopes: [], rateLimited: true });
    loadToken.mockResolvedValue('old-token'); // file untouched by the noop
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(200);
    expect(loadToken).toHaveBeenCalledTimes(1); // one read, zero poll iterations
  });

  // --- Stale-mount mitigation: a lagging mount read is re-polled ---
  it('re-polls a stale read after a real refresh until the new token appears', async () => {
    loadToken
      .mockResolvedValueOnce('old-token') // first read still stale
      .mockResolvedValueOnce('old-token') // first poll iteration still stale
      .mockResolvedValue('fresh-token'); // then the write propagates
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const opts = baseOpts(send);
    const out = await authedRequest(opts);
    expect(out.status).toBe(200);
    expect(opts.state.accessToken).toBe('fresh-token');
    expect(loadToken).toHaveBeenCalledTimes(3);
  });
});

describe('authedSdkCall', () => {
  beforeEach(() => {
    refreshAccessToken.mockReset();
    loadToken.mockReset();
    refreshAccessToken.mockResolvedValue({ expiresIn: 3600, grantedScopes: [] });
    loadToken.mockResolvedValue('fresh-token');
  });

  const authError = () => Object.assign(new Error('platform error'), { auth: true });
  const isAuthError = (err: unknown): boolean => Boolean((err as { auth?: boolean }).auth);

  function sdkOpts<T>(send: (t: string) => Promise<T>) {
    return {
      service: 'slack',
      state: { accessToken: 'old-token' },
      lock: new RefreshLock(),
      send,
      isAuthError,
    };
  }

  // --- Happy path: a successful call never refreshes ---
  it('returns the result without refreshing on success', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const out = await authedSdkCall(sdkOpts(send));
    expect(out).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- Auth error: refresh + retry once with the fresh token ---
  it('refreshes and retries once on an auth error', async () => {
    const send = vi.fn().mockRejectedValueOnce(authError()).mockResolvedValueOnce('retried');
    const opts = sdkOpts(send);
    const out = await authedSdkCall(opts);
    expect(out).toBe('retried');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, 'old-token');
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
    expect(opts.state.accessToken).toBe('fresh-token');
  });

  // --- Non-auth errors pass through untouched ---
  it('rethrows non-auth errors without refreshing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    await expect(authedSdkCall(sdkOpts(send))).rejects.toThrow('channel_not_found');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // --- Retry exactly once: a persistent auth error propagates, no loop ---
  it('propagates a persistent auth error after one refresh', async () => {
    const send = vi.fn().mockRejectedValue(authError());
    await expect(authedSdkCall(sdkOpts(send))).rejects.toThrow('platform error');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  // --- Refresh failure propagates (e.g. invalid_grant from the worker) ---
  it('propagates a refresh failure', async () => {
    refreshAccessToken.mockRejectedValue(new Error('invalid_grant: token_revoked'));
    const send = vi.fn().mockRejectedValue(authError());
    await expect(authedSdkCall(sdkOpts(send))).rejects.toThrow('invalid_grant');
    expect(send).toHaveBeenCalledTimes(1);
  });

  // --- Single-flight: concurrent auth failures trigger ONE refresh ---
  it('serializes concurrent refreshes — two parallel auth failures refresh once', async () => {
    const lock = new RefreshLock();
    const state = { accessToken: 'old-token' };
    let refreshes = 0;
    refreshAccessToken.mockImplementation(async () => {
      refreshes += 1;
      return { expiresIn: 3600, grantedScopes: [] };
    });
    const mkSend = () => vi.fn().mockRejectedValueOnce(authError()).mockResolvedValueOnce('ok');
    const [a, b] = await Promise.all([
      authedSdkCall({ service: 'slack', state, lock, send: mkSend(), isAuthError }),
      authedSdkCall({ service: 'slack', state, lock, send: mkSend(), isAuthError }),
    ]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(refreshes).toBe(1);
  });
});
