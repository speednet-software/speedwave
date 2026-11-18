import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

const loadToken = vi.fn();
const accessTokenExpiresWithin = vi.fn();
const refreshFailure = vi.fn();

vi.mock('./oauth-client.js', () => ({
  accessTokenExpiresWithin: (...a: unknown[]) => accessTokenExpiresWithin(...a),
  refreshFailure: (...a: unknown[]) => refreshFailure(...a),
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
    vi.useFakeTimers();
    loadToken.mockReset();
    accessTokenExpiresWithin.mockReset();
    refreshFailure.mockReset();
    accessTokenExpiresWithin.mockReturnValue(false);
    loadToken.mockResolvedValue('fresh-token');
    refreshFailure.mockResolvedValue(new Error('status message'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.TOKENS_DIR;
  });

  function baseOpts(send: (t: string) => Promise<Response>) {
    return { service: 'glpi', state: { accessToken: 'old-token' }, lock: new RefreshLock(), send };
  }

  it('returns a 200 without reading the token file', async () => {
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('retries once with the rewritten token on 401', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(200);
    expect(loadToken).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, 'old-token');
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('does NOT refresh on a 400 by default', async () => {
    const send = vi.fn().mockResolvedValue(resp(400));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('retries on 400 when authFailureStatuses includes it', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(400)).mockResolvedValueOnce(resp(200));
    const out = await authedRequest({ ...baseOpts(send), authFailureStatuses: [400, 401] });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('does NOT refresh on a 5xx, 403 or 404', async () => {
    for (const status of [503, 403, 404]) {
      const send = vi.fn().mockResolvedValue(resp(status));
      const out = await authedRequest(baseOpts(send));
      expect(out.status).toBe(status);
    }
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('retries exactly once: a persistent 401 is returned, not looped', async () => {
    const send = vi.fn().mockResolvedValue(resp(401));
    const out = await authedRequest(baseOpts(send));
    expect(out.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects authFailureStatuses containing a status below 400', async () => {
    const send = vi.fn().mockResolvedValue(resp(200));
    await expect(
      authedRequest({ ...baseOpts(send), authFailureStatuses: [200, 401] })
    ).rejects.toThrow(/>= 400/);
  });

  it('updates state.accessToken from the rewritten token', async () => {
    const opts = baseOpts(
      vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200))
    );
    await authedRequest(opts);
    expect(opts.state.accessToken).toBe('fresh-token');
  });

  it('reads access_token from the tokensDir override', async () => {
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    await authedRequest({ ...baseOpts(send), tokensDir: '/custom/tokens' });
    expect(loadToken).toHaveBeenCalledWith(join('/custom/tokens', 'access_token'));
  });

  it('reads access_token from TOKENS_DIR when no override is given', async () => {
    process.env.TOKENS_DIR = '/env/tokens';
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    await authedRequest(baseOpts(send));
    expect(loadToken).toHaveBeenCalledWith(join('/env/tokens', 'access_token'));
  });

  it('polls the file until the host writes a new token, then retries', async () => {
    loadToken
      .mockResolvedValueOnce('old-token')
      .mockResolvedValueOnce('old-token')
      .mockResolvedValue('fresh-token');
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const opts = baseOpts(send);
    const pending = authedRequest(opts);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;
    expect(out.status).toBe(200);
    expect(opts.state.accessToken).toBe('fresh-token');
    expect(loadToken).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('treats an empty file as unchanged while the host is writing', async () => {
    loadToken.mockResolvedValueOnce('').mockResolvedValue('fresh-token');
    const send = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const pending = authedRequest(baseOpts(send));
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('gives up after 30 s with the refresh_status message and does not retry the call', async () => {
    const failure = new Error('Slack sign-in expired.');
    refreshFailure.mockResolvedValue(failure);
    loadToken.mockResolvedValue('old-token');
    const send = vi.fn().mockResolvedValue(resp(401));
    let settled = false;
    const pending = authedRequest({ ...baseOpts(send), tokensDir: '/t' });
    const assertion = expect(pending).rejects.toBe(failure);
    pending.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(settled).toBe(true);
    expect(refreshFailure).toHaveBeenCalledWith('glpi', '/t');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates a token file read error', async () => {
    loadToken.mockRejectedValue(new Error('Token file not found'));
    const send = vi.fn().mockResolvedValue(resp(401));
    await expect(authedRequest(baseOpts(send))).rejects.toThrow('Token file not found');
  });

  it('serializes concurrent refreshes: two parallel 401s read the file once', async () => {
    const lock = new RefreshLock();
    const state = { accessToken: 'old-token' };
    const mkSend = () => vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
    const [a, b] = await Promise.all([
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
      authedRequest({ service: 'glpi', state, lock, send: mkSend() }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(loadToken).toHaveBeenCalledTimes(1);
    expect(lock.generation).toBe(1);
  });

  it('does not bump the lock generation when the wait times out', async () => {
    loadToken.mockResolvedValue('old-token');
    const lock = new RefreshLock();
    const send = vi.fn().mockResolvedValue(resp(401));
    const assertion = expect(
      authedRequest({ service: 'glpi', state: { accessToken: 'old-token' }, lock, send })
    ).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(lock.generation).toBe(0);
  });

  it('does NOT read the file proactively when the token is not near expiry', async () => {
    const send = vi.fn().mockResolvedValue(resp(200));
    await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('adopts a rewritten token before sending when the token is near expiry', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('fresh-token');
  });

  it('sends with the current token without waiting when near expiry and the file is unchanged', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    loadToken.mockResolvedValue('old-token');
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledWith('old-token');
    expect(loadToken).toHaveBeenCalledTimes(1);
  });

  it('falls through to the request when reading the file proactively fails', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    loadToken.mockRejectedValue(new Error('Token file not found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue(resp(200));
    const out = await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(out.status).toBe(200);
    expect(send).toHaveBeenCalledWith('old-token');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Token file not found'));
  });

  it('warns with the stringified value when the proactive read throws a non-Error', async () => {
    accessTokenExpiresWithin.mockReturnValue(true);
    loadToken.mockRejectedValue('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockResolvedValue(resp(200));
    await authedRequest({ ...baseOpts(send), proactiveWithinSeconds: 120 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('authedSdkCall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadToken.mockReset();
    refreshFailure.mockReset();
    loadToken.mockResolvedValue('fresh-token');
    refreshFailure.mockResolvedValue(new Error('status message'));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('returns the result without reading the token file on success', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const out = await authedSdkCall(sdkOpts(send));
    expect(out).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('retries once with the rewritten token on an auth error', async () => {
    const send = vi.fn().mockRejectedValueOnce(authError()).mockResolvedValueOnce('retried');
    const opts = sdkOpts(send);
    const out = await authedSdkCall(opts);
    expect(out).toBe('retried');
    expect(send).toHaveBeenNthCalledWith(1, 'old-token');
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
    expect(opts.state.accessToken).toBe('fresh-token');
  });

  it('rethrows non-auth errors without reading the token file', async () => {
    const send = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    await expect(authedSdkCall(sdkOpts(send))).rejects.toThrow('channel_not_found');
    expect(loadToken).not.toHaveBeenCalled();
  });

  it('propagates a persistent auth error after one retry', async () => {
    const send = vi.fn().mockRejectedValue(authError());
    await expect(authedSdkCall(sdkOpts(send))).rejects.toThrow('platform error');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws the refresh_status error when the token stays unchanged for 30 s', async () => {
    const failure = new Error('Slack token expired and has not been refreshed yet.');
    refreshFailure.mockResolvedValue(failure);
    loadToken.mockResolvedValue('old-token');
    const send = vi.fn().mockRejectedValue(authError());
    const assertion = expect(authedSdkCall(sdkOpts(send))).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent refreshes: two parallel auth failures read the file once', async () => {
    const lock = new RefreshLock();
    const state = { accessToken: 'old-token' };
    const mkSend = () => vi.fn().mockRejectedValueOnce(authError()).mockResolvedValueOnce('ok');
    const [a, b] = await Promise.all([
      authedSdkCall({ service: 'slack', state, lock, send: mkSend(), isAuthError }),
      authedSdkCall({ service: 'slack', state, lock, send: mkSend(), isAuthError }),
    ]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(loadToken).toHaveBeenCalledTimes(1);
  });
});
