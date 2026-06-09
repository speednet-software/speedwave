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
