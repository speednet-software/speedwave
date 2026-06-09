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

const { authedRequest, RefreshLock } = await import('./oauth-authed-request.js');

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

  // --- Proactive failure is non-fatal: fall through with the current token ---
  it('falls through to the request when a proactive refresh fails', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    refreshAccessToken.mockRejectedValue(new Error('worker_unreachable'));
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledWith('old-token'); // kept the pre-refresh token
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

  // --- Single-flight: concurrent 401s trigger ONE refresh, not N ---
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
    expect(refreshes).toBe(1); // second caller reused the first refresh (token changed)
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
});
