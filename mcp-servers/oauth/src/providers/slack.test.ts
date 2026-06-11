import { describe, it, expect, afterEach, vi } from 'vitest';
import { slackProvider, redactSlackError, refreshSlackToken } from './slack.js';
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

function slackReq(overrides: Partial<RefreshRequest> = {}): RefreshRequest {
  return {
    grantType: 'refresh_token',
    refreshToken: 'xoxe-1-old',
    scopes: ['chat:write', 'channels:history'],
    providerData: { clientId: '123.456' },
    ...overrides,
  };
}

/** Flat refresh-response shape (token rotation docs). */
const FLAT_OK = {
  ok: true,
  access_token: 'xoxe.xoxp-new',
  refresh_token: 'xoxe-1-new',
  expires_in: 43200,
  token_type: 'user',
};

describe('refreshSlackToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts the flat refresh-response shape and rotates the refresh token', async () => {
    mockJson({ body: FLAT_OK });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('xoxe.xoxp-new');
      expect(result.value.refreshToken).toBe('xoxe-1-new');
      expect(result.value.expiresIn).toBe(43200);
      // No scope in response → falls back to requested scopes.
      expect(result.value.grantedScopes).toEqual(['chat:write', 'channels:history']);
    }
  });

  it('accepts the nested authed_user shape (exchange-style response)', async () => {
    mockJson({
      body: {
        ok: true,
        app_id: 'A123',
        access_token: 'xoxb-bot-token-must-be-ignored',
        token_type: 'bot',
        authed_user: {
          id: 'U123',
          access_token: 'xoxe.xoxp-nested',
          refresh_token: 'xoxe-1-nested',
          expires_in: 43200,
          token_type: 'user',
          scope: 'chat:write,channels:history',
        },
      },
    });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('xoxe.xoxp-nested');
      expect(result.value.refreshToken).toBe('xoxe-1-nested');
      expect(result.value.grantedScopes).toEqual(['chat:write', 'channels:history']);
    }
  });

  it('sends grant_type/refresh_token/client_id and never scope or client_secret', async () => {
    mockJson({ body: FLAT_OK });
    await refreshSlackToken(slackReq());
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/oauth.v2.access');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=xoxe-1-old');
    expect(body).toContain('client_id=123.456');
    expect(body).not.toContain('scope');
    expect(body).not.toContain('client_secret');
    expect(init.redirect).toBe('manual');
  });

  it('rejects a flat token whose token_type is not user (bot token)', async () => {
    mockJson({ body: { ...FLAT_OK, token_type: 'bot' } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('malformed');
      expect(result.error.message).toContain('not user');
    }
  });

  it('rejects a nested token whose token_type is not user', async () => {
    mockJson({
      body: {
        ok: true,
        authed_user: { access_token: 'xoxb-evil', token_type: 'bot', expires_in: 43200 },
      },
    });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  it.each(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'token_revoked'])(
    'maps ok:false error %s on HTTP 200 to invalid_grant (re-login class)',
    async (slug) => {
      mockJson({ body: { ok: false, error: slug } });
      const result = await refreshSlackToken(slackReq());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_grant');
        expect(result.error.message).toBe(slug);
      }
    }
  );

  it('maps an unknown ok:false slug to http and passes the slug through', async () => {
    mockJson({ body: { ok: false, error: 'fatal_error' } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('http');
      expect(result.error.message).toBe('fatal_error');
    }
  });

  it('redacts a free-form ok:false error value', async () => {
    mockJson({ body: { ok: false, error: 'Bearer xoxe-1-LEAKED secret!' } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('redacted');
  });

  it('handles ok:false with no error field (uses HTTP status placeholder)', async () => {
    mockJson({ status: 429, body: { ok: false } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('http');
      expect(result.error.message).toBe('http_429');
    }
  });

  it('rejects a response without expires_in (rotation disabled = broken state)', async () => {
    mockJson({ body: { ...FLAT_OK, expires_in: undefined } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('malformed');
      expect(result.error.message).toContain('rotation');
    }
  });

  it('rejects ok:true with no token at all', async () => {
    mockJson({ body: { ok: true } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('access_token missing');
  });

  it('parses whitespace-separated scope as a fallback', async () => {
    mockJson({ body: { ...FLAT_OK, scope: 'chat:write users:read' } });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.grantedScopes).toEqual(['chat:write', 'users:read']);
  });

  it('returns http on an unexpected redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 302, ok: false, headers: { get: () => null } })
    );
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('http');
  });

  it('returns network on a fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('network');
      expect(result.error.message).toContain('ECONNRESET');
    }
  });

  it('returns malformed on a non-JSON content type', async () => {
    mockJson({ body: FLAT_OK, contentType: 'text/html' });
    const result = await refreshSlackToken(slackReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });
});

describe('refreshSlackToken edge shapes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('aborts a hung token endpoint and maps the non-Error rejection to network', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Reject with a plain string: exercises the String(err) arm.
            init.signal?.addEventListener('abort', () => reject('aborted by timeout'));
          })
      )
    );

    const pending = refreshSlackToken(slackReq());
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('network');
      expect(result.error.message).toContain('aborted by timeout');
    }
  });

  it('accepts a nested shape without refresh_token and scope', async () => {
    mockJson({
      body: {
        ok: true,
        authed_user: { access_token: 'xoxe.xoxp-min', expires_in: 43200, token_type: 'user' },
      },
    });

    const result = await refreshSlackToken(slackReq());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('xoxe.xoxp-min');
      expect(result.value.refreshToken).toBeUndefined();
      expect(result.value.grantedScopes).toEqual(['chat:write', 'channels:history']);
    }
  });

  it('accepts a flat shape without refresh_token', async () => {
    mockJson({
      body: { ok: true, access_token: 'xoxe.xoxp-flat', expires_in: 43200, token_type: 'user' },
    });

    const result = await refreshSlackToken(slackReq());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.refreshToken).toBeUndefined();
    }
  });
});

describe('slackProvider.refresh', () => {
  afterEach(() => vi.restoreAllMocks());

  it('delegates to refreshSlackToken (provider-object entry point)', async () => {
    mockJson({ body: FLAT_OK });
    const result = await slackProvider.refresh(slackReq());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('xoxe.xoxp-new');
    }
  });
});

describe('slackProvider.validateRequest', () => {
  it('accepts a well-formed refresh request', () => {
    expect(slackProvider.validateRequest!(slackReq())).toBeNull();
  });

  it('accepts an absent grantType (optional in the shared state type; treated as refresh_token)', () => {
    expect(slackProvider.validateRequest!(slackReq({ grantType: undefined }))).toBeNull();
  });

  it('rejects the client_credentials grant', () => {
    const err = slackProvider.validateRequest!(slackReq({ grantType: 'client_credentials' }));
    expect(err?.code).toBe('malformed');
  });

  it('rejects a missing clientId', () => {
    const err = slackProvider.validateRequest!(slackReq({ providerData: {} }));
    expect(err?.code).toBe('missing_field');
  });

  it('rejects an empty refreshToken', () => {
    const err = slackProvider.validateRequest!(slackReq({ refreshToken: '' }));
    expect(err?.code).toBe('missing_field');
  });
});

describe('redactSlackError', () => {
  it('passes machine slugs through', () => {
    expect(redactSlackError('invalid_auth')).toBe('invalid_auth');
  });

  it('redacts values with spaces, uppercase, or over-length', () => {
    expect(redactSlackError('Some Free Text')).toBe('redacted');
    expect(redactSlackError('a'.repeat(65))).toBe('redacted');
    expect(redactSlackError('')).toBe('redacted');
  });
});
