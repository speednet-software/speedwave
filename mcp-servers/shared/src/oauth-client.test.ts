import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshAccessToken, OAuthScopeMismatchError, OAuthRefreshError } from './oauth-client.js';

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
});
