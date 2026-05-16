import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { refreshMicrosoftToken } from './microsoft.js';

describe('refreshMicrosoftToken', () => {
  const baseReq = {
    clientId: '11111111-1111-1111-1111-111111111111',
    tenantId: 'common',
    scopes: ['https://graph.microsoft.com/Sites.Manage.All', 'offline_access'],
    refreshToken: 'r-old',
  };

  beforeEach(() => {
    // no-op — each test stubs fetch
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchResponse(init: { status?: number; ok?: boolean; body: unknown }): void {
    const status = init.status ?? 200;
    const ok = init.ok ?? (status >= 200 && status < 300);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status,
        ok,
        json: async () => init.body,
      })
    );
  }

  it('returns ok on a well-formed 200 response', async () => {
    mockFetchResponse({
      body: {
        access_token: 'a-new',
        refresh_token: 'r-new',
        expires_in: 3600,
        scope: 'https://graph.microsoft.com/Sites.Manage.All offline_access',
        token_type: 'Bearer',
      },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('a-new');
      expect(result.value.refreshToken).toBe('r-new');
      expect(result.value.expiresIn).toBe(3600);
      expect(result.value.grantedScopes).toContain('offline_access');
    }
  });

  it('returns network error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS lookup failed')));
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('network');
      expect(result.error.message).toContain('DNS lookup failed');
    }
  });

  it('returns network error when fetch is aborted (30s timeout)', async () => {
    // AbortController fires after 30s on a hung Microsoft token endpoint —
    // surfaces as the same `network` error path. Explicit test so the
    // timeout contract is not lost in a future refactor.
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('network');
      expect(result.error.message).toContain('aborted');
    }
  });

  it('actually fires the AbortController callback on the 30s timeout', async () => {
    // Cover the `() => controller.abort()` arrow passed to setTimeout —
    // production timer is 30s; use fake timers so the callback fires in ms.
    // No file I/O in this module, so fake timers do not interfere.
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      // Reject only when aborted; otherwise return a never-resolving promise.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          observedSignal = init.signal as AbortSignal;
          return new Promise((_resolve, reject) => {
            observedSignal!.addEventListener('abort', () => {
              const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
              reject(e);
            });
          });
        })
      );
      const promise = refreshMicrosoftToken(baseReq);
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await promise;
      expect(observedSignal?.aborted).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('network');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns malformed when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error('Unexpected end of JSON input');
        },
      })
    );
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('classifies invalid_grant with scope wording as scope_mismatch', async () => {
    mockFetchResponse({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'AADSTS65001: The user has not consented to scope X',
      },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('scope_mismatch');
  });

  it('classifies invalid_grant without scope wording as invalid_grant', async () => {
    mockFetchResponse({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'AADSTS70008: refresh token expired',
      },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_grant');
  });

  it('returns http for other HTTP errors', async () => {
    mockFetchResponse({
      status: 500,
      body: { error: 'server_error' },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('http');
  });

  it('returns malformed when access_token is missing', async () => {
    mockFetchResponse({
      body: { expires_in: 3600, scope: baseReq.scopes.join(' ') },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('returns malformed when expires_in is missing or invalid', async () => {
    mockFetchResponse({
      body: { access_token: 'a', expires_in: -1, scope: baseReq.scopes.join(' ') },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('detects scope mismatch when granted is a strict subset of requested', async () => {
    mockFetchResponse({
      body: {
        access_token: 'a',
        expires_in: 3600,
        // only offline_access granted; Sites.Manage.All missing
        scope: 'offline_access',
      },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('scope_mismatch');
      expect(result.error.message).toContain('Sites.Manage.All');
    }
  });

  it('keeps the previous refresh token when Microsoft does not rotate it', async () => {
    mockFetchResponse({
      body: {
        access_token: 'a',
        expires_in: 3600,
        scope: baseReq.scopes.join(' '),
      },
    });
    const result = await refreshMicrosoftToken(baseReq);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.refreshToken).toBeUndefined();
  });

  it('encodes the tenant id in the URL path', async () => {
    const captured: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        captured.push({ url });
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            access_token: 'a',
            expires_in: 3600,
            scope: baseReq.scopes.join(' '),
          }),
        });
      })
    );
    await refreshMicrosoftToken({ ...baseReq, tenantId: 'with space' });
    expect(captured[0].url).toContain('with%20space');
  });
});
