import { describe, it, expect, afterEach, vi } from 'vitest';
import { genericProvider, redactGenericError, refreshGenericToken } from './generic.js';
import type { RefreshRequest } from './types.js';

/** Builds a fetch mock returning a JSON token response with the given body. */
function mockJson(init: { status?: number; body: unknown; contentType?: string }): void {
  const status = init.status ?? 200;
  const ok = status >= 200 && status < 300;
  const bytes = Buffer.from(JSON.stringify(init.body), 'utf8');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      ok,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-type' ? (init.contentType ?? 'application/json') : null,
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
  );
}

function refreshTokenReq(overrides: Partial<RefreshRequest> = {}): RefreshRequest {
  return {
    grantType: 'refresh_token',
    refreshToken: 'r-old',
    scopes: ['read', 'write'],
    providerData: {
      tokenUrl: 'https://idp.example.com/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      authStyle: 'basic',
    },
    ...overrides,
  };
}

describe('refreshGenericToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refresh_token grant: returns ok on a well-formed 200', async () => {
    mockJson({
      body: {
        access_token: 'a-new',
        refresh_token: 'r-new',
        expires_in: 3600,
        scope: 'read write',
      },
    });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('a-new');
      expect(result.value.refreshToken).toBe('r-new');
      expect(result.value.grantedScopes).toEqual(['read', 'write']);
    }
  });

  it('rejects an unparseable token URL', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({
        providerData: { tokenUrl: 'not a url at all', clientId: 'cid' },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('rejects a token URL with embedded credentials', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({
        providerData: { tokenUrl: 'https://user:pass@idp.example.com/token', clientId: 'cid' },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('rejects a localhost token URL', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({
        providerData: { tokenUrl: 'https://localhost/token', clientId: 'cid' },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('rejects a success body with a non-positive expires_in', async () => {
    mockJson({ body: { access_token: 'a', expires_in: 0 } });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('expires_in');
  });

  it('validateRequest requires providerData.tokenUrl', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({ providerData: { clientId: 'cid' } })
    );
    expect(err?.code).toBe('missing_field');
    expect(err?.message).toContain('tokenUrl');
  });

  it('validateRequest requires providerData.clientId', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({ providerData: { tokenUrl: 'https://idp.example.com/token' } })
    );
    expect(err?.code).toBe('missing_field');
    expect(err?.message).toContain('clientId');
  });

  it('actually fires the AbortController callback on the refresh timeout', async () => {
    // Cover the `() => controller.abort()` arrow passed to setTimeout —
    // production timer is TIMEOUTS.TOKEN_REFRESH_MS; fake timers fire it in ms.
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          observedSignal = init.signal as AbortSignal;
          return new Promise((_resolve, reject) => {
            observedSignal!.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        })
      );
      const promise = refreshGenericToken(refreshTokenReq());
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;
      expect(observedSignal?.aborted).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('network');
    } finally {
      vi.useRealTimers();
    }
  });

  it('validateRequest requires clientSecret for client_credentials', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({
        grantType: 'client_credentials',
        refreshToken: '',
        providerData: { tokenUrl: 'https://idp.example.com/token', clientId: 'cid' },
      })
    );
    expect(err?.code).toBe('missing_field');
    expect(err?.message).toContain('clientSecret');
  });

  it('genericProvider.refresh delegates to refreshGenericToken', async () => {
    mockJson({ body: { access_token: 'a', expires_in: 60 } });
    const result = await genericProvider.refresh(refreshTokenReq());
    expect(result.ok).toBe(true);
  });

  it('accepts application/json with a charset parameter', async () => {
    mockJson({
      body: { access_token: 'a', expires_in: 60 },
      contentType: 'application/json; charset=utf-8',
    });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(true);
  });

  it('accepts a +json suffix content-type (application/problem+json)', async () => {
    mockJson({
      body: { access_token: 'a', expires_in: 60 },
      contentType: 'application/problem+json',
    });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(true);
  });

  it('rejects a crafted content-type that merely contains "json"', async () => {
    // /json/i substring matching would pass these — the anchored check must not.
    mockJson({
      body: { access_token: 'a', expires_in: 60 },
      contentType: 'text/jsonx',
    });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('content-type');
  });

  it('rejects an unknown providerData.authStyle literal', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({
        providerData: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'cid',
          authStyle: 'header-magic',
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('malformed');
      expect(result.error.message).toContain('authStyle');
    }
  });

  it('rejects an unknown providerData.grantType literal', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({
        grantType: undefined,
        providerData: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'cid',
          grantType: 'implicit',
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('malformed');
      expect(result.error.message).toContain('grantType');
    }
  });

  it('validateRequest rejects an unknown authStyle before any network call', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({
        providerData: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'cid',
          authStyle: 'nope',
        },
      })
    );
    expect(err?.code).toBe('malformed');
  });

  it('basic auth style: sends Authorization: Basic header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ access_token: 'a', expires_in: 60 })).buffer,
    });
    vi.stubGlobal('fetch', fetchSpy);
    await refreshGenericToken(
      refreshTokenReq({
        providerData: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'cid',
          clientSecret: 'sec',
          authStyle: 'basic',
        },
      })
    );
    const init = fetchSpy.mock.calls[0][1] as {
      headers: Record<string, string>;
      body: URLSearchParams;
    };
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body.has('client_secret')).toBe(false);
  });

  it('body auth style: sends client_id/client_secret in the body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ access_token: 'a', expires_in: 60 })).buffer,
    });
    vi.stubGlobal('fetch', fetchSpy);
    await refreshGenericToken(
      refreshTokenReq({
        providerData: {
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'cid',
          clientSecret: 'sec',
          authStyle: 'body',
        },
      })
    );
    const init = fetchSpy.mock.calls[0][1] as {
      headers: Record<string, string>;
      body: URLSearchParams;
    };
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.body.get('client_id')).toBe('cid');
    expect(init.body.get('client_secret')).toBe('sec');
  });

  it('client_credentials grant: omits refresh_token, sets grant_type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ access_token: 'a', expires_in: 60 })).buffer,
    });
    vi.stubGlobal('fetch', fetchSpy);
    await refreshGenericToken(
      refreshTokenReq({ grantType: 'client_credentials', refreshToken: '' })
    );
    const init = fetchSpy.mock.calls[0][1] as { body: URLSearchParams };
    expect(init.body.get('grant_type')).toBe('client_credentials');
    expect(init.body.has('refresh_token')).toBe(false);
  });

  it('rejects a non-https token_url', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({ providerData: { tokenUrl: 'http://idp.example.com/token', clientId: 'c' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('rejects a loopback token_url (defense in depth)', async () => {
    const result = await refreshGenericToken(
      refreshTokenReq({ providerData: { tokenUrl: 'https://127.0.0.1/token', clientId: 'c' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('maps invalid_grant and redacts error_description', async () => {
    mockJson({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'secret tenant detail leak' },
    });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_grant');
      expect(result.error.message).not.toContain('secret tenant detail');
    }
  });

  it('rejects a non-JSON content-type', async () => {
    mockJson({ body: { access_token: 'a', expires_in: 60 }, contentType: 'text/html' });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('rejects a response missing access_token', async () => {
    mockJson({ body: { expires_in: 60 } });
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('returns network error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('network');
  });

  it('rejects a response body over the size cap', async () => {
    // 257 KiB > MAX_BODY_BYTES (256 KiB).
    const big = new ArrayBuffer(257 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => big,
      })
    );
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('refuses to follow a redirect (3xx)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        ok: false,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    );
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('http');
  });

  it('aborts on timeout (AbortError surfaces as network)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      })
    );
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('network');
  });

  it.each([
    ['https://[::ffff:10.0.0.1]/token', 'ipv4-mapped private'],
    ['https://100.64.0.1/token', 'CGNAT'],
    ['https://0.0.0.1/token', '0.0.0.0/8'],
    ['https://169.254.169.254/token', 'link-local metadata'],
    ['http://idp.example.com/token', 'non-https'],
  ])('rejects an unsafe token_url (%s)', async (tokenUrl) => {
    const result = await refreshGenericToken(
      refreshTokenReq({ providerData: { tokenUrl, clientId: 'c', authStyle: 'basic' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it('streams and rejects an oversized body before fully buffering it', async () => {
    // A real ReadableStream whose chunks exceed the 256 KiB cap.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: {
          get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        body: stream,
      })
    );
    const result = await refreshGenericToken(refreshTokenReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
    expect(cancelled).toBe(true); // read was aborted, not fully buffered
  });
});

describe('genericProvider.validateRequest', () => {
  it('passes a valid refresh_token request', () => {
    expect(genericProvider.validateRequest?.(refreshTokenReq())).toBeNull();
  });

  it('rejects refresh_token grant with empty refreshToken', () => {
    const err = genericProvider.validateRequest?.(refreshTokenReq({ refreshToken: '' }));
    expect(err?.code).toBe('missing_field');
  });

  it('rejects client_credentials grant without clientSecret', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({
        grantType: 'client_credentials',
        refreshToken: '',
        providerData: { tokenUrl: 'https://idp.example.com/token', clientId: 'c' },
      })
    );
    expect(err?.code).toBe('missing_field');
  });

  it('rejects missing tokenUrl', () => {
    const err = genericProvider.validateRequest?.(
      refreshTokenReq({ providerData: { tokenUrl: '', clientId: 'c' } })
    );
    expect(err?.code).toBe('missing_field');
  });
});

describe('redactGenericError', () => {
  it('keeps a known RFC 6749 error code', () => {
    expect(redactGenericError('invalid_grant')).toBe('invalid_grant');
    expect(redactGenericError('invalid_client')).toBe('invalid_client');
  });
  it('redacts an empty code', () => {
    expect(redactGenericError('')).toBe('redacted');
  });
  it('redacts a non-enum (attacker-stuffed) error value', () => {
    expect(redactGenericError('tenant=acme; refresh_token=LEAKED_abc')).toBe('redacted');
    expect(redactGenericError('some_future_error')).toBe('redacted');
  });
});
