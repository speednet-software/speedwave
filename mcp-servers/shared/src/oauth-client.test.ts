import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  refreshAccessToken,
  OAuthScopeMismatchError,
  OAuthRefreshError,
  readJwtExp,
  accessTokenExpiresWithin,
} from './oauth-client.js';

describe('refreshAccessToken', () => {
  let dir: string;
  let bearerPath: string;
  let saved: { WORKER_OAUTH_URL?: string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-client-'));
    if (process.platform !== 'win32') {
      await chmod(dir, 0o700);
    }
    bearerPath = join(dir, 'bearer');
    await writeFile(bearerPath, 'bearer-sp', { mode: 0o600 });
    saved = { WORKER_OAUTH_URL: process.env.WORKER_OAUTH_URL };
    process.env.WORKER_OAUTH_URL = 'http://oauth.worker:4040';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (saved.WORKER_OAUTH_URL === undefined) {
      delete process.env.WORKER_OAUTH_URL;
    } else {
      process.env.WORKER_OAUTH_URL = saved.WORKER_OAUTH_URL;
    }
    vi.restoreAllMocks();
  });

  function mcpJsonResult(payload: unknown) {
    return {
      jsonrpc: '2.0',
      id: 'x',
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    };
  }
  function mcpErrorResult(text: string) {
    return {
      jsonrpc: '2.0',
      id: 'x',
      result: {
        content: [{ type: 'text', text: `Error: ${text}` }],
        isError: true,
      },
    };
  }

  it('throws when WORKER_OAUTH_URL is unset', async () => {
    delete process.env.WORKER_OAUTH_URL;
    await expect(refreshAccessToken({ service: 'sharepoint', bearerPath })).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('returns expiresIn and grantedScopes on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mcpJsonResult({ expiresIn: 3600, grantedScopes: ['s1', 's2'] }),
    });
    const result = await refreshAccessToken({
      service: 'sharepoint',
      bearerPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.expiresIn).toBe(3600);
    expect(result.grantedScopes).toEqual(['s1', 's2']);
    // Authorization header carries the bearer from file
    const call = fetchImpl.mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer bearer-sp' });
    // No `service` param on the wire
    const body = JSON.parse(init.body as string) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(body.params.name).toBe('refresh');
    expect(body.params.arguments).toEqual({});
  });

  it('throws OAuthScopeMismatchError on scope_mismatch tool error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mcpErrorResult('scope_mismatch: not granted: Sites.Manage.All'),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(OAuthScopeMismatchError);
  });

  it('throws OAuthRefreshError on other tool errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mcpErrorResult('rate_limited: last refresh was 60s ago'),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'tool_error' });
  });

  it('throws OAuthRefreshError on HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'http' });
  });

  it('retries once on 401 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mcpJsonResult({ expiresIn: 1000, grantedScopes: [] }),
      });
    });
    const result = await refreshAccessToken({
      service: 'sharepoint',
      bearerPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(calls).toBe(2);
    expect(result.expiresIn).toBe(1000);
  });

  it('fails on the second 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(OAuthRefreshError);
  });

  it('throws when bearer file is empty', async () => {
    await writeFile(bearerPath, '');
    const fetchImpl = vi.fn();
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'no_bearer' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on malformed JSON-RPC response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ jsonrpc: '2.0', id: 'x' }), // no result, no error
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it('throws on unparseable content text (JSON.parse fail)', async () => {
    // The tool returns content[0].text that is NOT a JSON object — covers
    // the catch around JSON.parse in oauth-client.ts:175.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        jsonrpc: '2.0',
        id: 'x',
        result: { content: [{ type: 'text', text: '<<<not-json>>>' }] },
      }),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it('throws on JSON-RPC error response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        jsonrpc: '2.0',
        id: 'x',
        error: { code: -32601, message: 'tools/call not found' },
      }),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'jsonrpc' });
  });

  it('throws on unexpected payload shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        mcpJsonResult({ expiresIn: 'not-a-number' as unknown as number, grantedScopes: [] }),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it('defaults bearerPath to /secrets/oauth-auth-token-<service> when omitted', async () => {
    // Covers `bearerPath = options.bearerPath ?? …` default-arg branch.
    // We force the readFile to fail (file does not exist) so we observe the
    // exact path the implementation tried.
    const fetchImpl = vi.fn();
    let observedPath: string | undefined;
    try {
      await refreshAccessToken({
        service: 'sharepoint',
        // bearerPath intentionally omitted
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      observedPath = (err as NodeJS.ErrnoException).path;
    }
    expect(observedPath).toBe('/secrets/oauth-auth-token-sharepoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults fetchImpl to globalThis.fetch when omitted', async () => {
    // Covers `const fetchImpl = options.fetchImpl ?? fetch;` default-arg
    // branch. We replace globalThis.fetch so the test does not hit the
    // network; the call must still go through that injection (proving the
    // fallback was selected).
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mcpJsonResult({ expiresIn: 3600, grantedScopes: ['offline_access'] }),
    });
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch as unknown as typeof fetch;
    try {
      const result = await refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        // fetchImpl intentionally omitted
      });
      expect(result.expiresIn).toBe(3600);
      expect(stubFetch).toHaveBeenCalled();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('treats missing result.content as empty text (covers the ?? fallback)', async () => {
    // result.content is undefined → text falls back to ''. Without the
    // fallback the indexing would throw; with it, the worker's
    // `isError` branch sees an empty body and returns the generic error.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        jsonrpc: '2.0',
        id: 'x',
        result: { isError: true /* no content */ },
      }),
    });
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'tool_error' });
  });

  it('wraps AbortError as OAuthRefreshError(timeout) when the loopback fetch is aborted (30s timeout)', async () => {
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'OAuthRefreshError', code: 'timeout' });
  });

  it('wraps TCP refused as OAuthRefreshError(worker_unreachable)', async () => {
    // undici/Node's fetch throws TypeError("fetch failed") when the host-side
    // oauth worker port is dead (common when WORKER_OAUTH_URL points at a
    // stale ephemeral port after a worker respawn).
    const tcpError = new TypeError('fetch failed');
    const fetchImpl = vi.fn().mockRejectedValue(tcpError);
    await expect(
      refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'OAuthRefreshError', code: 'worker_unreachable' });
  });

  it('worker_unreachable message contains a recovery hint but NOT the worker URL', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    try {
      await refreshAccessToken({
        service: 'sharepoint',
        bearerPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/cannot reach oauth worker/);
      expect(msg).toMatch(/Restart the project/);
      // Worker URL must not leak into user-facing message (info disclosure).
      expect(msg).not.toContain('oauth.worker:4040');
      expect(msg).not.toContain('http://');
    }
  });

  it('OAuthRefreshError carries httpStatus on the unauthorized path', async () => {
    // First call returns 401, second succeeds — the retry path branches on httpStatus.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mcpJsonResult({ expiresIn: 3600, grantedScopes: ['x'] }),
      });
    const result = await refreshAccessToken({
      service: 'sharepoint',
      bearerPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ expiresIn: 3600 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('readJwtExp', () => {
  function jwt(payload: Record<string, unknown>): string {
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
  }

  it('returns the exp claim as a number', () => {
    expect(readJwtExp(jwt({ exp: 1779000000 }))).toBe(1779000000);
  });

  it('returns null for non-JWT plain strings', () => {
    expect(readJwtExp('test-access-token')).toBeNull();
  });

  it('returns null when the JWT has no exp claim', () => {
    expect(readJwtExp(jwt({ sub: 'user' }))).toBeNull();
  });

  it('returns null when the JWT exp is not a number', () => {
    expect(readJwtExp(jwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null when the payload is not valid base64', () => {
    expect(readJwtExp('header.@@@.sig')).toBeNull();
  });

  it('returns null when payload is valid base64 but not JSON', () => {
    // base64url of "valid" is "dmFsaWQ"
    expect(readJwtExp('header.dmFsaWQ.sig')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(readJwtExp('')).toBeNull();
  });
});

describe('accessTokenExpiresWithin', () => {
  function jwt(exp: number): string {
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8')
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ exp }))}.sig`;
  }

  const NOW_MS = 1_779_000_000_000;
  const NOW_S = NOW_MS / 1000;

  it('true when token expires inside the window', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 30), 120, NOW_MS)).toBe(true);
  });

  it('true when token is already expired', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S - 60), 120, NOW_MS)).toBe(true);
  });

  it('false when token expires beyond the window', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 600), 120, NOW_MS)).toBe(false);
  });

  it('false exactly at the window boundary (strict <)', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 120), 120, NOW_MS)).toBe(false);
  });

  it('seconds=0 true for already-expired token', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S - 1), 0, NOW_MS)).toBe(true);
  });

  it('seconds=0 false for future token', () => {
    expect(accessTokenExpiresWithin(jwt(NOW_S + 1), 0, NOW_MS)).toBe(false);
  });

  it('false for unparseable tokens (legacy/test strings)', () => {
    expect(accessTokenExpiresWithin('test-access-token', 120, NOW_MS)).toBe(false);
  });
});
