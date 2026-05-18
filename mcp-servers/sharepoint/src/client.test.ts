/**
 * Comprehensive tests for SharePoint/Microsoft Graph API Client
 * Target: 90%+ code coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetupGuidance } from '@speedwave/mcp-shared';
import {
  SharePointClient,
  initializeSharePointClient,
  SharePointConfig,
  validateGraphSiteId,
  resolveCompositeSiteId,
} from './client.js';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn().mockReturnValue({}),
  };
});
vi.mock('stream/promises', () => ({
  pipeline: vi.fn(),
}));
vi.mock('@speedwave/mcp-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@speedwave/mcp-shared')>();
  return {
    ...actual,
    loadToken: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue({
      expiresIn: 3600,
      grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All'],
    }),
    ts: () => '[00:00:00]',
  };
});

const mockFs = vi.mocked(fs);
const mockCreateWriteStream = vi.mocked(createWriteStream);
const mockPipeline = vi.mocked(pipeline);
const { loadToken, refreshAccessToken } = await import('@speedwave/mcp-shared');
const mockLoadToken = vi.mocked(loadToken);
const mockOauthRefresh = vi.mocked(refreshAccessToken);

// Test configuration
const mockConfig: SharePointConfig = {
  clientId: 'test-client-id',
  tenantId: 'test-tenant-id',
  siteId: 'test-site-id',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
};

const mockTokensDir = '/test/tokens';

/** Build a fake JWT with the given payload for proactive-refresh tests. */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) =>
    Buffer.from(s, 'utf8')
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

describe('SharePointClient', () => {
  let client: SharePointClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock global fetch
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    // After ADR-060, SharePointClient.refreshAccessToken re-reads access_token
    // from /tokens after the oauth worker writes it. Default the mock to a
    // valid token so 401-retry paths can proceed.
    mockLoadToken.mockResolvedValue('refreshed-access-token');
    mockOauthRefresh.mockResolvedValue({
      expiresIn: 3600,
      grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All'],
    });

    // Create fresh client instance
    client = new SharePointClient({ ...mockConfig }, mockTokensDir);

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Constructor & Configuration
  //═══════════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('should initialize with valid config', () => {
      expect(client).toBeInstanceOf(SharePointClient);
      expect(client.getConfig()).toEqual(mockConfig);
    });

    it('should store tokens directory', () => {
      const config = client.getConfig();
      expect(config.clientId).toBe(mockConfig.clientId);
    });
  });

  // Health getters delegate to TokenManager. Cheap to test, important for
  // the OAuth diagnostics path used by the Desktop integrations card.
  describe('token save error getters', () => {
    it('getLastTokenSaveError starts null and survives clear', () => {
      expect(client.getLastTokenSaveError()).toBeNull();
      client.clearTokenSaveError();
      expect(client.getLastTokenSaveError()).toBeNull();
    });

    it('getHealthStatus exposes tokenSaveError', () => {
      expect(client.getHealthStatus()).toEqual({ tokenSaveError: null });
    });
  });

  describe('getSiteId', () => {
    it('returns the configured site id (site-policy SSOT)', () => {
      expect(client.getSiteId()).toBe(mockConfig.siteId);
    });
  });

  // 401 → host-side oauth worker refresh → retry. The new path (ADR-060)
  // replaces the v1 Microsoft endpoint hit; this batch covers the wiring.
  describe('refreshAccessToken (delegated to host-side oauth worker)', () => {
    it('on 401 calls oauthRefreshAccessToken and reloads access_token from /tokens', async () => {
      // First call: Graph returns 401 → triggers refresh path.
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
      mockOauthRefresh.mockResolvedValueOnce({
        expiresIn: 3600,
        grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All'],
      });
      mockLoadToken.mockResolvedValueOnce('new-access-token-after-refresh');
      // Retry call: Graph returns 200.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(mockOauthRefresh).toHaveBeenCalledWith({ service: 'sharepoint' });
      expect(mockLoadToken).toHaveBeenCalled();
    });

    it('throws if oauth worker reports success but no access_token is written', async () => {
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
      mockOauthRefresh.mockResolvedValueOnce({
        expiresIn: 3600,
        grantedScopes: [],
      });
      mockLoadToken.mockResolvedValueOnce(''); // empty / placeholder

      await expect(client.listFiles()).rejects.toThrow(
        /oauth worker returned success but access_token was not written/
      );
    });

    it('propagates OAuthScopeMismatchError as-is so the tool layer can re-consent', async () => {
      const { OAuthScopeMismatchError } = await import('@speedwave/mcp-shared');
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
      mockOauthRefresh.mockRejectedValueOnce(
        new OAuthScopeMismatchError('Sites.Manage.All not granted')
      );

      await expect(client.listFiles()).rejects.toThrow(/Sites\.Manage\.All not granted/);
    });

    it('wraps non-Error rejections from the oauth worker in Error', async () => {
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
      mockOauthRefresh.mockRejectedValueOnce('plain string rejection');

      await expect(client.listFiles()).rejects.toThrow(/plain string rejection/);
    });
  });

  // debugLog() is gated by process.env.DEBUG and only fires from the
  // callGraphAPI 401 → refresh path. Covers both DEBUG branches.
  describe('debugLog (via callGraphAPI 401 → refresh path)', () => {
    it('emits the refresh log line when DEBUG is set', async () => {
      const prev = process.env.DEBUG;
      process.env.DEBUG = '1';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
        mockOauthRefresh.mockResolvedValueOnce({
          expiresIn: 3600,
          grantedScopes: [],
        });
        mockLoadToken.mockResolvedValueOnce('fresh-token');
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

        await client.listFiles();

        expect(
          logSpy.mock.calls.some((args) => String(args[0]).includes('Access token expired'))
        ).toBe(true);
      } finally {
        logSpy.mockRestore();
        if (prev === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = prev;
      }
    });

    it('stays silent when DEBUG is not set', async () => {
      const prev = process.env.DEBUG;
      delete process.env.DEBUG;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
        mockOauthRefresh.mockResolvedValueOnce({
          expiresIn: 3600,
          grantedScopes: [],
        });
        mockLoadToken.mockResolvedValueOnce('fresh-token');
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [] }),
        });

        await client.listFiles();

        expect(
          logSpy.mock.calls.some((args) => String(args[0]).includes('Access token expired'))
        ).toBe(false);
      } finally {
        logSpy.mockRestore();
        if (prev !== undefined) process.env.DEBUG = prev;
      }
    });
  });

  // graphRequest is the public Graph wrapper used by tools/page-tools.ts +
  // tools/list-tools.ts (PR4 / PR5). Hits every code path of the helper:
  // path form, absolute-URL form, body + Content-Type injection, 204 no
  // content, non-2xx with Graph error message, non-2xx with non-JSON body.
  describe('graphRequest', () => {
    it('expands /sites/{site-id} path and adds v1.0 prefix', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: [] }),
      });
      await client.graphRequest('GET', '/sites/{site-id}/pages');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://graph.microsoft.com/v1.0/sites/${mockConfig.siteId}/pages`);
    });

    it('uses the path as-is when not in /sites/{site-id} form', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
      await client.graphRequest('GET', '/me');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me');
    });

    it('passes an absolute URL through untouched', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
      await client.graphRequest('GET', 'https://graph.microsoft.com/v1.0/me');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me');
    });

    it('JSON-stringifies body and sets Content-Type when body is provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'new' }),
      });
      const body = { displayName: 'List' };
      await client.graphRequest('POST', '/sites/{site-id}/lists', body);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(JSON.stringify(body));
      expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('returns undefined for 204 No Content', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });
      const result = await client.graphRequest('DELETE', '/sites/{site-id}/lists/L1');
      expect(result).toBeUndefined();
    });

    it('throws Error with Graph error.message when response has JSON error body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: { message: 'invalid_request' } }),
      });
      await expect(client.graphRequest('GET', '/sites/{site-id}/pages')).rejects.toThrow(
        /Graph API GET .* failed: 400 Bad Request: invalid_request/
      );
    });

    it('falls back to status line when error response body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('not json');
        },
      });
      await expect(client.graphRequest('GET', '/sites/{site-id}/pages')).rejects.toThrow(
        /Graph API GET .* failed: 500 Internal Server Error/
      );
    });

    it('falls back to status line when Graph returns valid JSON without an error.message field', async () => {
      // Some Graph error responses arrive as `{}` or `{error: {}}`. Without
      // a message we keep the bare status line — appending ": undefined"
      // would be a regression caller error UIs surface.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: async () => ({ error: {} }),
      });
      await expect(client.graphRequest('PATCH', '/sites/{site-id}/pages')).rejects.toThrow(
        /Graph API PATCH .* failed: 422 Unprocessable Entity$/
      );
    });
  });

  // SharePointClient.formatError() is a static helper used by every tool's
  // wrapErr() — coverage of its branches is what makes audit/diagnostics
  // surfaces consistent.
  describe('formatError', () => {
    it('rewrites 401 / Unauthorized with setup guidance', () => {
      expect(SharePointClient.formatError(new Error('401 Unauthorized'))).toMatch(
        /token may have expired/
      );
    });

    it('rewrites 403 / Forbidden', () => {
      expect(SharePointClient.formatError(new Error('403 Forbidden'))).toMatch(/Permission denied/);
    });

    it('rewrites 404 / not found', () => {
      expect(SharePointClient.formatError(new Error('404 not found'))).toMatch(
        /Resource not found/
      );
    });

    it('rewrites security check / traversal errors', () => {
      expect(SharePointClient.formatError(new Error('security check failed'))).toMatch(
        /security check failed/
      );
      expect(SharePointClient.formatError(new Error('path traversal not allowed'))).toMatch(
        /security check failed/
      );
    });

    it('passes other messages through verbatim', () => {
      expect(SharePointClient.formatError(new Error('something else'))).toBe('something else');
    });

    it('handles errors without message (truthy empty)', () => {
      expect(SharePointClient.formatError({ message: undefined })).toMatch(/SharePoint API error/);
    });
  });

  describe('callGraphAPI', () => {
    it('should call Graph API with authorization header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockConfig.accessToken}`,
          }),
        })
      );
    });

    it('should retry on 401 with refreshed token', async () => {
      // First call returns 401 → triggers refresh (via mocked oauth-client) → retry
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });
      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      // ADR-060: refresh is delegated to the host-side oauth worker (mocked).
      // The fetch sequence is now: Initial(401) + Retry — not Initial + refresh + retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockOauthRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'sharepoint' })
      );
    });

    it('proactively refreshes before fetch when JWT exp is near', async () => {
      // 60s expiry is well under the 120s proactive window even on a slow CI host.
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const expiringClient = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry }) },
        mockTokensDir
      );
      mockLoadToken.mockResolvedValueOnce('post-proactive-refresh-token');
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

      await expiringClient.listFiles();

      expect(mockOauthRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'sharepoint' })
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer post-proactive-refresh-token',
          }),
        })
      );
    });

    it('does NOT proactively refresh when JWT exp is far in the future', async () => {
      const farExpiry = Math.floor(Date.now() / 1000) + 3600;
      const freshClient = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: farExpiry }) },
        mockTokensDir
      );
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

      await freshClient.listFiles();

      expect(mockOauthRefresh).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to existing token when proactive refresh fails with worker_unreachable', async () => {
      const { OAuthRefreshError } = await import('@speedwave/mcp-shared');
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const expiringClient = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry, label: 'stale' }) },
        mockTokensDir
      );
      // Proactive refresh fails — oauth worker unreachable.
      mockOauthRefresh.mockRejectedValueOnce(
        new OAuthRefreshError('worker_unreachable', 'cannot reach oauth worker')
      );
      // The Graph request proceeds with the stale (but still valid for ~60s) token.
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

      await expiringClient.listFiles();

      expect(mockOauthRefresh).toHaveBeenCalledTimes(1);
      // listFiles still made its fetch with the existing (pre-refresh) token.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to existing token when proactive refresh fails with timeout', async () => {
      const { OAuthRefreshError } = await import('@speedwave/mcp-shared');
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const expiringClient = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry }) },
        mockTokensDir
      );
      mockOauthRefresh.mockRejectedValueOnce(
        new OAuthRefreshError('timeout', 'oauth worker did not respond within 30s.')
      );
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

      await expiringClient.listFiles();

      expect(mockOauthRefresh).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-throws OAuthScopeMismatchError from proactive refresh (cannot self-heal)', async () => {
      const { OAuthScopeMismatchError } = await import('@speedwave/mcp-shared');
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const expiringClient = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry }) },
        mockTokensDir
      );
      mockOauthRefresh.mockRejectedValueOnce(
        new OAuthScopeMismatchError('Sites.Manage.All not granted')
      );

      await expect(expiringClient.listFiles()).rejects.toBeInstanceOf(OAuthScopeMismatchError);
      // No fetch should have been attempted — scope mismatch will not be fixed by retry.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('proactive refresh double-check skips a redundant call when another caller already refreshed', async () => {
      // Two concurrent calls enter proactive refresh because the cached JWT is
      // near expiry. The mutex serializes them; the second one, after acquiring
      // the lock, must observe that this.config.accessToken changed and SKIP
      // its own oauth.refresh — otherwise we waste a round-trip to the host
      // oauth worker on every overlapping tool call.
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const client = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry }) },
        mockTokensDir
      );
      mockLoadToken.mockResolvedValueOnce('post-shared-refresh');
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ value: [] }) });

      await Promise.all([client.listFiles(), client.listFiles()]);

      // Both calls completed but only ONE refresh round-trip happened.
      expect(mockOauthRefresh).toHaveBeenCalledTimes(1);
      // Both ultimately issued their Graph fetch using the refreshed token.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('logs proactive refresh failure when the rejection is a non-Error value', async () => {
      // refreshAccessToken could in theory reject with a plain string (older
      // shared/oauth-client paths did so before typed errors landed). The
      // fall-through path must still produce a usable warning instead of
      // crashing on `e.message` of a non-Error.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const nearExpiry = Math.floor(Date.now() / 1000) + 60;
      const client = new SharePointClient(
        { ...mockConfig, accessToken: makeJwt({ exp: nearExpiry }) },
        mockTokensDir
      );
      mockOauthRefresh.mockRejectedValueOnce('opaque string failure');
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });

      await client.listFiles();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('opaque string failure'));
      // Fell through to Graph with the stale-but-still-valid token.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('should use already-refreshed token when double-check detects another thread refreshed it', async () => {
      // The double-check locking path is exercised by making two concurrent requests.
      // When both get 401 simultaneously, the second one to acquire the mutex finds that
      // the token was already refreshed by the first, so it retries with the new token.

      // Setup: two concurrent listFiles calls
      // Call 1 (first to acquire mutex): 401 → refresh → retry succeeds
      // Call 2 (second to acquire mutex): 401 → double-check sees token changed → retry succeeds
      let fetchCallCount = 0;

      mockFs.writeFile.mockResolvedValue(undefined);

      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        const n = fetchCallCount;

        if (n === 1 || n === 2) {
          // Both initial requests get 401
          return { status: 401, ok: false } as Response;
        }
        if (n === 3) {
          // Token refresh OAuth call (only one should happen)
          return {
            ok: true,
            json: async () => ({
              access_token: 'refreshed-token',
              refresh_token: 'refreshed-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          } as Response;
        }
        // Retries for both requests succeed
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        } as Response;
      }) as typeof fetch;

      // Run two concurrent requests
      const [result1, result2] = await Promise.all([client.listFiles(), client.listFiles()]);

      expect(result1.files).toEqual([]);
      expect(result2.files).toEqual([]);
      // Should be: 2 initial calls + 1 OAuth refresh + 2 retries = 5 calls
      // OR: 2 initial + 1 OAuth + 1 double-check retry + 1 retry = 5 calls
      expect(fetchCallCount).toBeGreaterThanOrEqual(4);
    });

    it('should timeout during retry after double-check detects token already refreshed', async () => {
      // Two concurrent 401s; second hits double-check path; its retry times out
      let fetchCallCount = 0;
      mockFs.writeFile.mockResolvedValue(undefined);

      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        const n = fetchCallCount;
        if (n === 1 || n === 2) {
          return { status: 401, ok: false } as Response;
        }
        if (n === 3) {
          // OAuth refresh succeeds
          return {
            ok: true,
            json: async () => ({
              access_token: 'new-token',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          } as Response;
        }
        // First retry after own-refresh succeeds; second retry (double-check path) times out
        if (n === 4) {
          return { ok: true, status: 200, json: async () => ({ value: [] }) } as Response;
        }
        // Double-check retry times out
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }) as typeof fetch;

      // One will succeed, one might timeout — just ensure no unhandled rejection
      const results = await Promise.allSettled([client.listFiles(), client.listFiles()]);
      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
        expect(reason.message).toMatch(/timeout/i);
      }
    });

    it('re-throws non-Abort retry errors verbatim after double-check sees a refreshed token', async () => {
      // Surface real network failures during the post-double-check retry
      // instead of swallowing them as timeouts — important for diagnostics
      // when DNS dies mid-tool-call.
      mockFs.writeFile.mockResolvedValue(undefined);
      mockLoadToken
        .mockResolvedValueOnce('first-refresh-token')
        .mockResolvedValueOnce('first-refresh-token');
      let fetchCallCount = 0;
      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        const n = fetchCallCount;
        // Both initial calls 401.
        if (n === 1 || n === 2) return { status: 401, ok: false } as Response;
        // First retry (own-refresh) succeeds.
        if (n === 3)
          return { ok: true, status: 200, json: async () => ({ value: [] }) } as Response;
        // Second retry (double-check path with token-changed) hits a non-Abort
        // network blip — must surface verbatim, not as a timeout.
        throw new TypeError('fetch failed');
      }) as typeof fetch;

      const results = await Promise.allSettled([client.listFiles(), client.listFiles()]);
      const rejected = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      expect(rejected).toBeDefined();
      const err = (rejected as PromiseRejectedResult).reason as Error;
      expect(err.message).not.toMatch(/timeout/i);
      expect(err.message).toMatch(/fetch failed/);
    });

    it('wraps AbortError as a request-timeout message after double-check sees a refreshed token', async () => {
      // Double-check path: second concurrent call's retry aborts. The error
      // must be surfaced as the typed timeout message so diagnostics are
      // consistent with the other retry paths.
      mockFs.writeFile.mockResolvedValue(undefined);
      mockLoadToken
        .mockResolvedValueOnce('first-refresh-token')
        .mockResolvedValueOnce('first-refresh-token');
      let fetchCallCount = 0;
      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        const n = fetchCallCount;
        if (n === 1 || n === 2) return { status: 401, ok: false } as Response;
        if (n === 3)
          return { ok: true, status: 200, json: async () => ({ value: [] }) } as Response;
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }) as typeof fetch;

      const results = await Promise.allSettled([client.listFiles(), client.listFiles()]);
      const rejected = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      expect(rejected).toBeDefined();
      const err = (rejected as PromiseRejectedResult).reason as Error;
      expect(err.message).toMatch(/Graph API request timeout after/);
    });

    it('wraps AbortError as a request-timeout message during own-refresh retry', async () => {
      // Reactive 401 → host oauth refresh writes new access_token → retry the
      // Graph fetch. If THAT retry itself aborts, surface a typed timeout
      // message so callers see "Graph API request timeout after Xms" instead
      // of the raw AbortError name leaking into diagnostics.
      mockLoadToken.mockResolvedValueOnce('post-refresh-token');
      fetchMock
        .mockResolvedValueOnce({ status: 401, ok: false }) // initial 401
        .mockImplementationOnce(async () => {
          // retry after refresh: aborts
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          throw abortError;
        });

      await expect(client.listFiles()).rejects.toThrow(/Graph API request timeout after/);
    });

    it('re-throws non-Abort retry errors verbatim during own-refresh retry', async () => {
      // Same shape as above but the retry hits a non-Abort network blip
      // (TypeError("fetch failed") from undici). Must not be misreported
      // as a timeout — DNS / TCP / TLS failures need their real message.
      mockLoadToken.mockResolvedValueOnce('post-refresh-token');
      fetchMock
        .mockResolvedValueOnce({ status: 401, ok: false })
        .mockRejectedValueOnce(new TypeError('socket hang up'));

      await expect(client.listFiles()).rejects.toThrow(/socket hang up/);
    });

    it('should merge custom headers with authorization', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test content'));

      // File upload succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 12 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
            'Content-Type': 'application/octet-stream',
          }),
        })
      );
    });
  });

  // getDriveItemForSharePointPath is the lookup path that addImageWebPart
  // relies on — it must reject traversal attempts before issuing a Graph
  // call, and must surface usable errors when Graph returns 4xx/5xx or a
  // malformed payload.
  describe('getDriveItemForSharePointPath', () => {
    it('rejects path-traversal input before issuing any Graph call (security)', async () => {
      await expect(client.getDriveItemForSharePointPath('../../etc/passwd')).rejects.toThrow(
        /Invalid sharepoint_path \(security check failed\)/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses Graph error.message when the lookup fails with an error body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: { message: 'itemNotFound: hero.jpg' } }),
      });
      await expect(
        client.getDriveItemForSharePointPath('Shared Documents/hero.jpg')
      ).rejects.toThrow(/itemNotFound: hero\.jpg/);
    });

    it('falls back to status line when Graph error body has no message field', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => ({ error: {} }),
      });
      await expect(client.getDriveItemForSharePointPath('Shared Documents/x.png')).rejects.toThrow(
        /driveItem lookup failed: 500 Server Error/
      );
    });

    it('rejects responses missing id or sharepointIds (defensive parse)', async () => {
      // Graph normally returns both fields, but a malformed/incomplete payload
      // would surface as a confusing error later in addImageWebPart. Fail fast.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'hero.jpg' /* no id, no sharepointIds */ }),
      });
      await expect(
        client.getDriveItemForSharePointPath('Shared Documents/hero.jpg')
      ).rejects.toThrow(/response missing id or sharepointIds/);
    });

    it('returns the full DriveItem on a complete response', async () => {
      const payload = {
        id: 'drive-item-1',
        name: 'hero.jpg',
        webUrl: 'https://example/hero.jpg',
        size: 1024,
        image: { width: 800, height: 600 },
        sharepointIds: { listId: 'L1', listItemId: 'I1', listItemUniqueId: 'U1', siteId: 'S1' },
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => payload,
      });
      const result = await client.getDriveItemForSharePointPath('Shared Documents/hero.jpg');
      expect(result).toEqual(payload);
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Path Handling
  //═══════════════════════════════════════════════════════════════════════════════

  describe('encodeGraphPath', () => {
    it('should encode path segments for Graph API', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles({ path: 'folder with spaces/file.txt' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('folder%20with%20spaces/file.txt'),
        expect.any(Object)
      );
    });

    it('should handle special characters in paths', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles({ path: 'folder/file&name.txt' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('file%26name.txt'),
        expect.any(Object)
      );
    });
  });

  describe('validatePath', () => {
    it('should reject path with parent directory traversal (../', async () => {
      await expect(client.listFiles({ path: '../etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with Windows parent directory traversal (..\\)', async () => {
      await expect(client.listFiles({ path: '..\\windows\\system32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject absolute paths starting with /', async () => {
      await expect(client.listFiles({ path: '/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject absolute paths starting with \\', async () => {
      await expect(client.listFiles({ path: '\\windows\\system32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject paths with null bytes', async () => {
      await expect(client.listFiles({ path: 'file\0.txt' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    // URL-encoded traversal tests (security fix #1)
    it('should reject URL-encoded path traversal (%2e%2e)', async () => {
      await expect(client.listFiles({ path: '%2e%2e/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject double-encoded path traversal (%252e%252e)', async () => {
      await expect(client.listFiles({ path: '%252e%252e/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject mixed URL-encoded traversal (..%2f)', async () => {
      await expect(client.listFiles({ path: '..%2f..%2fetc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject URL-encoded backslash traversal (%2e%2e%5c)', async () => {
      await expect(client.listFiles({ path: '%2e%2e%5cwindows%5csystem32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject standalone ".." in path', async () => {
      await expect(client.listFiles({ path: 'folder/../secret' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject invalid URL encoding', async () => {
      // Invalid percent encoding should be rejected
      await expect(client.listFiles({ path: '%GG/file.txt' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should accept valid relative paths', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await expect(client.listFiles({ path: 'valid/path/to/folder' })).resolves.toBeDefined();
    });

    it('should accept empty path', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await expect(client.listFiles({ path: '' })).resolves.toBeDefined();
    });
  });

  describe('API timeout (security fix #2)', () => {
    it('should timeout on slow Graph API response', async () => {
      // Mock slow response that takes longer than API_TIMEOUT_MS (30000ms)
      // We'll simulate abort by making fetch reject with AbortError
      fetchMock.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        });
      });

      await expect(client.listFiles()).rejects.toThrow(/timeout/i);
    });

    it('should timeout on slow token refresh', async () => {
      // First call returns 401 (trigger refresh)
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh hangs and times out
      fetchMock.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        });
      });

      await expect(client.listFiles()).rejects.toThrow(/timeout/i);
    });

    it('should trigger the API timeout callback when using fake timers', async () => {
      vi.useFakeTimers();

      // Make fetch hang forever so the timer fires and aborts the signal
      fetchMock.mockImplementationOnce((_url: string, opts: RequestInit) => {
        // Return a promise that only rejects when the signal is aborted
        return new Promise<Response>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const listPromise = client.listFiles();

      // Advance past the API timeout (TIMEOUTS.API_CALL_MS)
      vi.runAllTimers();

      await expect(listPromise).rejects.toThrow(/timeout/i);
      vi.useRealTimers();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listFiles', () => {
    it('should list files in base directory', async () => {
      const mockFiles = [
        {
          id: 'file-1',
          name: 'document.docx',
          size: 1024,
          lastModifiedDateTime: '2023-01-01T00:00:00Z',
          webUrl: 'https://sharepoint.com/file1',
        },
        {
          id: 'folder-1',
          name: 'Reports',
          folder: {},
          webUrl: 'https://sharepoint.com/folder1',
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: mockFiles }),
      });

      const result = await client.listFiles();

      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({
        id: 'file-1',
        name: 'document.docx',
        path: 'document.docx',
        size: 1024,
        lastModified: '2023-01-01T00:00:00Z',
        isFolder: false,
        webUrl: 'https://sharepoint.com/file1',
      });
      expect(result.files[1]).toMatchObject({
        id: 'folder-1',
        name: 'Reports',
        path: 'Reports',
        isFolder: true,
      });
      expect(result.exists).toBe(true);
    });

    it('should list files in subdirectory', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'file-2', name: 'report.pdf', size: 2048 }],
        }),
      });

      const result = await client.listFiles({ path: 'Reports' });

      expect(result.files[0].path).toBe('Reports/report.pdf');
      // After dropping base_path, file ops resolve straight against the site
      // drive root — `listFiles({ path: 'Reports' })` hits
      // `/sites/{siteId}/drive/root:/Reports:/children`.
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`drive/root:/Reports:/children`),
        expect.any(Object)
      );
    });

    it('should handle empty directory', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      const result = await client.listFiles();

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(true);
    });

    it('should handle missing value in response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.listFiles();

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(true);
    });

    it('should throw error on API failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Access denied');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.listFiles()).rejects.toThrow('Failed to list files');
    });

    it('should return empty array when folder not found (404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Item not found' } }),
      });

      const result = await client.listFiles({ path: 'nonexistent-folder' });

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(false);
    });

    it('should throw error for 403 Forbidden (not 404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Access denied');
    });

    it('should throw error for 500 Server Error (not 404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Internal server error' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Internal server error');
    });

    it('should follow @odata.nextLink for paginated responses', async () => {
      // First page returns 2 items and a nextLink
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            { id: 'file-1', name: 'doc1.txt', size: 100 },
            { id: 'file-2', name: 'doc2.txt', size: 200 },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/nextpage?$skiptoken=abc',
        }),
      });

      // Second page returns 1 more item with no nextLink
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'file-3', name: 'doc3.txt', size: 300 }],
        }),
      });

      const result = await client.listFiles();

      expect(result.files).toHaveLength(3);
      expect(result.files[0].name).toBe('doc1.txt');
      expect(result.files[1].name).toBe('doc2.txt');
      expect(result.files[2].name).toBe('doc3.txt');
      expect(result.exists).toBe(true);

      // Second fetch should use the nextLink URL
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://graph.microsoft.com/v1.0/nextpage?$skiptoken=abc',
        expect.any(Object)
      );
    });
  });

  describe('getFileMetadata', () => {
    it('should retrieve file metadata by ID', async () => {
      const mockMetadata = {
        id: 'file-1',
        name: 'document.docx',
        size: 1024,
        createdDateTime: '2023-01-01T00:00:00Z',
        lastModifiedDateTime: '2023-01-02T00:00:00Z',
        eTag: '"abc123"',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockMetadata,
      });

      const result = await client.getFileMetadata('file-1');

      expect(result).toEqual(mockMetadata);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://graph.microsoft.com/v1.0/sites/${mockConfig.siteId}/drive/items/file-1`,
        expect.any(Object)
      );
    });

    it('should throw error when file not found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Item not found' } }),
      });

      await expect(client.getFileMetadata('invalid-id')).rejects.toThrow('Item not found');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.getFileMetadata('file-1')).rejects.toThrow('Failed to get file metadata');
    });
  });

  describe('getCurrentUser', () => {
    it('should retrieve current user information', async () => {
      const mockUser = {
        displayName: 'John Doe',
        mail: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
        id: 'user-123',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockUser,
      });

      const result = await client.getCurrentUser();

      expect(result).toEqual({
        displayName: 'John Doe',
        email: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
        id: 'user-123',
      });
    });

    it('should use userPrincipalName as email fallback', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          displayName: 'Jane Smith',
          userPrincipalName: 'jane.smith@example.com',
          id: 'user-456',
        }),
      });

      const result = await client.getCurrentUser();

      expect(result.email).toBe('jane.smith@example.com');
    });

    it('should handle missing user data with defaults', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.getCurrentUser();

      expect(result).toEqual({
        displayName: 'Unknown User',
        email: 'unknown@example.com',
        userPrincipalName: 'unknown',
        id: 'unknown',
      });
    });

    it('should throw error on API failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Unauthorized' } }),
      });

      await expect(client.getCurrentUser()).rejects.toThrow('Unauthorized');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.getCurrentUser()).rejects.toThrow('Failed to get user info');
    });
  });

  describe('uploadFile', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test file content'));
    });

    it('should upload file successfully', async () => {
      // Check parent folder 'remote' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'folder-remote' }),
      });

      // Upload file
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          eTag: '"abc123"',
          size: 17,
        }),
      });

      const result = await client.uploadFile('remote/file.txt', '/workspace/local/file.txt');

      expect(result).toEqual({
        etag: '"abc123"',
        size: 17,
      });

      expect(mockFs.readFile).toHaveBeenCalledWith('/workspace/local/file.txt');
    });

    it('should validate SharePoint path', async () => {
      await expect(client.uploadFile('../../../etc/passwd', '/workspace/file.txt')).rejects.toThrow(
        'Invalid sharepoint_path (security check failed)'
      );
    });

    it('should validate local path', async () => {
      await expect(client.uploadFile('file.txt', '/etc/passwd')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('should include expectedEtag in If-Match header', async () => {
      // Upload file with etag
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"new123"', size: 17 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt', {
        expectedEtag: '"old123"',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-Match': '"old123"',
          }),
        })
      );
    });

    it('should include If-None-Match header for createOnly', async () => {
      // Upload file with createOnly
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc123"', size: 17 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt', {
        createOnly: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': '*',
          }),
        })
      );
    });

    it('should skip conditional headers in overwrite mode', async () => {
      // Upload file
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"overwrite"', size: 17 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt', {
        overwrite: true,
        expectedEtag: '"ignored"',
      });

      // The upload call (last one) should NOT have If-Match header
      const uploadCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(uploadCall[1]?.headers).not.toHaveProperty('If-Match');
    });

    it('should ensure parent folders exist', async () => {
      // Check 'newfolder' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'newfolder'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-1' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc123"', size: 17 }),
      });

      await client.uploadFile('newfolder/file.txt', '/workspace/file.txt');

      // Should check parent folder exists
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/newfolder'),
        expect.not.objectContaining({ method: 'POST' })
      );

      // Should create parent folder
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/children'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error on upload failure', async () => {
      // Upload fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'Conflict' } }),
      });

      await expect(client.uploadFile('file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Conflict'
      );
    });

    it('should throw generic error when error message missing', async () => {
      // Upload fails without error message
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      await expect(client.uploadFile('file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Upload failed'
      );
    });
  });

  describe('downloadFile', () => {
    it('rejects traversal in sharepointPath', async () => {
      await expect(
        client.downloadFile('../../../etc/passwd', '/workspace/out.txt')
      ).rejects.toThrow('Invalid sharepoint_path');
    });

    it('rejects invalid local path', async () => {
      await expect(client.downloadFile('docs/file.txt', '/etc/passwd')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
    });

    it('throws when metadata response is not ok', async () => {
      // Metadata fetch fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Item not found' } }),
      });

      await expect(client.downloadFile('docs/file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Item not found'
      );
    });

    it('throws when metadata response is not ok and has no error message', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      await expect(client.downloadFile('docs/file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Failed to get file metadata for download'
      );
    });

    it('throws when no download URL in metadata', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file-1',
          name: 'file.txt',
          // No @microsoft.graph.downloadUrl
        }),
      });

      await expect(client.downloadFile('docs/file.txt', '/workspace/file.txt')).rejects.toThrow(
        'No download URL available for file'
      );
    });

    it('throws when download fetch fails', async () => {
      // Metadata succeeds with download URL
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file-1',
          name: 'file.txt',
          '@microsoft.graph.downloadUrl': 'https://cdn.example.com/file.txt',
        }),
      });

      // mkdir succeeds
      mockFs.mkdir.mockResolvedValue(undefined);

      // Actual file download fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        body: null,
      });

      await expect(client.downloadFile('docs/file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Download failed with status 403'
      );
    });

    it('throws when download response has no body', async () => {
      // Metadata succeeds with download URL
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file-1',
          name: 'file.txt',
          '@microsoft.graph.downloadUrl': 'https://cdn.example.com/file.txt',
        }),
      });

      // mkdir succeeds
      mockFs.mkdir.mockResolvedValue(undefined);

      // Actual file download has ok but no body
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      });

      await expect(client.downloadFile('docs/file.txt', '/workspace/file.txt')).rejects.toThrow(
        'No response body for download'
      );
    });

    it('streams file to disk successfully (happy path)', async () => {
      // Metadata succeeds with download URL
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'file-1',
          name: 'report.pdf',
          '@microsoft.graph.downloadUrl': 'https://cdn.example.com/report.pdf',
        }),
      });

      mockFs.mkdir.mockResolvedValue(undefined);

      // Create a minimal ReadableStream body
      const encoder = new TextEncoder();
      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('file content'));
          controller.close();
        },
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: bodyStream,
      });

      // Mock createWriteStream and pipeline
      const fakeWriteStream = { path: '/workspace/report.pdf' };
      mockCreateWriteStream.mockReturnValue(
        fakeWriteStream as unknown as ReturnType<typeof createWriteStream>
      );
      mockPipeline.mockResolvedValue(undefined);

      await expect(
        client.downloadFile('docs/report.pdf', '/workspace/report.pdf')
      ).resolves.toBeUndefined();

      expect(mockFs.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true });
      expect(mockCreateWriteStream).toHaveBeenCalledWith('/workspace/report.pdf');
      expect(mockPipeline).toHaveBeenCalled();
    });
  });

  describe('ensureParentFolders', () => {
    it('should create nested parent folders', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // First level folder 'level1' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-1' }),
      });

      // Second level folder 'level2' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-2' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.uploadFile('level1/level2/file.txt', '/workspace/file.txt');

      // Should create both new parent folders (level1 and level2)
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(2);
    });

    it('should skip folder creation if folder exists', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Parent folder 'existing' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'existing-folder' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.uploadFile('existing/file.txt', '/workspace/file.txt');

      // Should not create any folder (all exist)
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('should handle file in root directory', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt');

      // After dropping base_path: file in root has no parent segments to check,
      // so only the upload PUT happens.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should create folder at root level', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Check 'rootfolder' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create folder 'rootfolder'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'root-folder' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.uploadFile('rootfolder/file.txt', '/workspace/file.txt');

      // Should create folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][1]?.body).toContain('rootfolder');
    });

    it('should throw when ensureParentFolders is called directly with invalid path', async () => {
      await expect(client.ensureParentFolders('../traversal/file.txt')).rejects.toThrow(
        'Invalid path in ensureParentFolders (security check failed)'
      );
    });

    it('should return early from ensureParentFolders when path has no parent (single segment)', async () => {
      // A single segment path like "file.txt" has no parent — should return immediately
      // without making any API calls
      await client.ensureParentFolders('file.txt');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should create folder at root drive level when first segment does not exist', async () => {
      // When the first segment (accum = single segment) is 404, we call
      // buildFolderChildrenUrl("") which returns the root/children URL.
      // We test this via ensureParentFolders directly with a top-level path.
      // 'Documents' doesn't exist (404)
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'Documents' at root level (parentDir is "")
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'new-docs-folder' }),
      });

      await client.ensureParentFolders('Documents/file.txt');

      const createCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
      expect(createCall).toBeDefined();
      // The POST URL should be the root/children URL (no path segment in URL)
      expect(createCall![0]).toContain('/drive/root/children');
    });

    it('should handle folder creation failure in ensureParentFolders with text body', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // 'newdir' doesn't exist (404)
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'newdir' fails with non-409 status and returns text body
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 507,
        text: async () => 'Insufficient Storage',
        json: async () => ({}),
      });

      await expect(client.uploadFile('newdir/file.txt', '/workspace/file.txt')).rejects.toThrow(
        "Failed to create folder 'newdir': 507 - Insufficient Storage"
      );
    });

    it('should handle folder creation failure in ensureParentFolders when text() also throws', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // 'baddir' doesn't exist (404)
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'baddir' fails with non-409 and text() also throws
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 507,
        text: async () => {
          throw new Error('Body stream read error');
        },
      });

      await expect(client.uploadFile('baddir/file.txt', '/workspace/file.txt')).rejects.toThrow(
        "Failed to create folder 'baddir': 507 - Unable to read error body: Body stream read error"
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[sharepoint] Failed to read error body for folder creation: Body stream read error'
        )
      );
    });

    it('should handle 409 Conflict in ensureParentFolders (race condition - folder exists)', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // 'racedir' doesn't exist in first check (404)
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'racedir' returns 409 Conflict (already created by another process)
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'nameAlreadyExists' } }),
      });

      // File upload succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"xyz"', size: 4 }),
      });

      // Should not throw - 409 is treated as success (idempotent)
      await expect(
        client.uploadFile('racedir/file.txt', '/workspace/file.txt')
      ).resolves.toBeDefined();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Empty Folder Support
  //═══════════════════════════════════════════════════════════════════════════════

  describe('createRemoteFolder', () => {
    it('should create a new folder successfully', async () => {
      // Create folder succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'new-folder', name: 'newfolder' }),
      });

      await client.createRemoteFolder('newfolder');

      // Verify POST call to create folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][1]?.body).toContain('newfolder');
      expect(postCalls[0][1]?.body).toContain('"folder":{}');
    });

    it('should create nested folder with parent folders', async () => {
      // Check parent 'level1' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create parent 'level1'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'level1-folder' }),
      });

      // Create 'level2' folder
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'level2-folder', name: 'level2' }),
      });

      await client.createRemoteFolder('level1/level2');

      // Should create both parent and folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(2);
    });

    it('should handle 409 Conflict (folder already exists) as idempotent', async () => {
      // Create folder returns 409 Conflict (already exists)
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'Item already exists' } }),
      });

      // Should not throw error - idempotent operation
      await expect(client.createRemoteFolder('existing')).resolves.toBeUndefined();
    });

    it('should throw error on 403 Forbidden (permission denied)', async () => {
      // Create folder returns 403 Forbidden
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.createRemoteFolder('forbidden')).rejects.toThrow('Access denied');
    });

    it('should throw error on 500 Internal Server Error', async () => {
      // Create folder returns 500 Internal Server Error
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Internal server error' } }),
      });

      await expect(client.createRemoteFolder('servererror')).rejects.toThrow(
        'Internal server error'
      );
    });

    it('should validate path and reject traversal attempts', async () => {
      await expect(client.createRemoteFolder('../etc/passwd')).rejects.toThrow(
        'Invalid path (security check failed)'
      );

      await expect(client.createRemoteFolder('/etc/passwd')).rejects.toThrow(
        'Invalid path (security check failed)'
      );

      await expect(client.createRemoteFolder('folder/../../etc')).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should handle invalid folder path (empty string)', async () => {
      // Empty string is caught by path validator before we check folder name
      await expect(client.createRemoteFolder('')).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should throw when folder path has trailing slash (empty folder name)', async () => {
      // "folder/" passes path validation but splitPath gives empty folderName.
      // ensureParentFolders on "folder/" checks the single "folder" segment.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'folder-id' }),
      });

      await expect(client.createRemoteFolder('folder/')).rejects.toThrow(
        'Invalid folder path: cannot determine folder name'
      );
    });

    it('should fall back to text body when JSON parse of error response fails', async () => {
      // Create folder fails; JSON parse throws but text parse succeeds
      const errorResponse = {
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('Invalid JSON');
        },
        text: async () => 'Service Unavailable',
      };
      fetchMock.mockResolvedValueOnce(errorResponse);

      await expect(client.createRemoteFolder('broken')).rejects.toThrow(
        '503 - Service Unavailable'
      );
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should use fallback status message when both JSON and text parse fail', async () => {
      // Both JSON and text parsing fail on the error response
      const errorResponse = {
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('Invalid JSON');
        },
        text: async () => {
          throw new Error('Stream read error');
        },
      };
      fetchMock.mockResolvedValueOnce(errorResponse);

      await expect(client.createRemoteFolder('broken')).rejects.toThrow('Failed to create folder');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse error response as text'),
        expect.objectContaining({
          error: 'Stream read error',
          status: 503,
        })
      );
    });

    it('should fall back to text body when JSON parse fails (non-Error textParseError)', async () => {
      // JSON parse fails; text parse throws a non-Error value
      const errorResponse = {
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('Invalid JSON');
        },
        text: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'raw string error';
        },
      };
      fetchMock.mockResolvedValueOnce(errorResponse);

      await expect(client.createRemoteFolder('broken')).rejects.toThrow('Failed to create folder');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse error response as text'),
        expect.objectContaining({
          error: 'raw string error',
        })
      );
    });

    it('emits a debug log entry with the parseError context when DEBUG is set', async () => {
      // debugLog has a two-arg overload (message, data) used by createRemoteFolder
      // when JSON parsing fails. Under DEBUG=1 the log must include the parseError
      // so the operator can see *why* the body was unparseable, not just that it
      // was. This guards the two-arg branch from regressing when someone refactors
      // the logger.
      const prev = process.env.DEBUG;
      process.env.DEBUG = '1';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('boom');
          },
          text: async () => 'plain text body',
        });
        await expect(client.createRemoteFolder('x')).rejects.toThrow(/500 - plain text body/);
        const debugCall = logSpy.mock.calls.find((args) =>
          String(args[0]).includes('Failed to parse error response')
        );
        expect(debugCall).toBeDefined();
        expect(debugCall![1]).toMatchObject({ parseError: expect.any(Error) });
      } finally {
        logSpy.mockRestore();
        if (prev === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = prev;
      }
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Factory & Initialization
  //═══════════════════════════════════════════════════════════════════════════════

  describe('initializeSharePointClient', () => {
    const originalEnv = process.env.TOKENS_DIR;

    beforeEach(() => {
      delete process.env.TOKENS_DIR;
    });

    afterEach(() => {
      if (originalEnv) {
        process.env.TOKENS_DIR = originalEnv;
      } else {
        delete process.env.TOKENS_DIR;
      }
    });

    it('should initialize client with valid tokens', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('refresh_token')) return 'test-refresh-token';
        if (path.includes('client_id')) return 'test-client-id';
        if (path.includes('tenant_id')) return 'test-tenant-id';
        if (path.includes('site_id')) return 'test-site-id';
        if (path.includes('base_path')) return 'Documents/Test';
        return '';
      });

      const client = await initializeSharePointClient();

      expect(client).toBeInstanceOf(SharePointClient);
      expect(client?.getConfig().accessToken).toBe('test-access-token');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SharePoint tokens loaded'));
    });

    it('should use TOKENS_DIR environment variable', async () => {
      process.env.TOKENS_DIR = '/custom/tokens';

      mockLoadToken.mockImplementation(async () => 'token-value');

      await initializeSharePointClient();

      expect(mockLoadToken).toHaveBeenCalledWith(expect.stringContaining('/custom/tokens'));
    });

    it('should use /tokens as default directory', async () => {
      mockLoadToken.mockImplementation(async () => 'token-value');

      await initializeSharePointClient();

      expect(mockLoadToken).toHaveBeenCalledWith(expect.stringContaining('/tokens'));
    });

    it('should return null when tokens are empty', async () => {
      mockLoadToken.mockResolvedValue('');

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when access token is missing', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return '';
        return 'valid-token';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when loadToken throws error', async () => {
      mockLoadToken.mockRejectedValue(new Error('Token not found'));

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    // ADR-060 + base_path removal: SharePoint container mounts only
    // access_token / site_id. The other former fields (refresh_token /
    // client_id / tenant_id) live in the host-only oauth.json; base_path
    // was dropped because site_id already scopes the worker.
    it('should return null when any worker-mounted required token is missing', async () => {
      const required = ['access_token', 'site_id'];

      for (const key of required) {
        mockLoadToken.mockImplementation(async (path: string) => {
          if (path.includes(key)) return '';
          return 'valid';
        });

        const result = await initializeSharePointClient();
        expect(result).toBeNull();
        expect(console.warn).toHaveBeenCalled();
      }
    });

    it('should NOT require legacy fields removed by ADR-060', async () => {
      // refresh_token / client_id / tenant_id being absent must not block startup
      mockLoadToken.mockImplementation(async (path: string) => {
        if (
          path.includes('refresh_token') ||
          path.includes('client_id') ||
          path.includes('tenant_id')
        ) {
          return '';
        }
        return 'valid';
      });

      const result = await initializeSharePointClient();
      expect(result).not.toBeNull();
    });

    it('should return null when site_id is a SharePoint URL', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'https://contoso.sharepoint.com/sites/Speedwave';
        return '';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('site_id must be a Graph site id, not a URL')
      );
    });

    it('should return null when site_id contains whitespace', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'contoso.sharepoint.com, guid, guid';
        return '';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('site_id contains whitespace')
      );
    });

    it('should return null when site_id contains ".." traversal segment', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'contoso.sharepoint.com:/sites/../Other:';
        return '';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"..".'));
    });

    it('should accept composite-form site_id', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id'))
          return 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222';
        return '';
      });

      const result = await initializeSharePointClient();
      expect(result).not.toBeNull();
    });

    it('should accept path-form site_id and resolve it to composite via Graph lookup', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'contoso.sharepoint.com:/sites/Speedwave:';
        return '';
      });
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222',
        }),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      const result = await initializeSharePointClient();
      expect(result).not.toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/Speedwave:',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
        })
      );
      // Client stores the composite id, not the path-form the user typed.
      expect(result?.getConfig().siteId).toBe(
        'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222'
      );
    });

    it('should return null when path-form site_id lookup fails (404)', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'contoso.sharepoint.com:/sites/Nonexistent:';
        return '';
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as unknown as typeof fetch;
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
      infoSpy.mockRestore();
    });

    it('should surface a "transient" hint when site lookup returns 429', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('site_id')) return 'contoso.sharepoint.com:/sites/X:';
        return '';
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }) as unknown as typeof fetch;
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('transient'));
      infoSpy.mockRestore();
    });
  });

  describe('validateGraphSiteId', () => {
    it('accepts composite form', () => {
      expect(
        validateGraphSiteId(
          'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222'
        )
      ).toBeNull();
    });

    it('accepts path form', () => {
      expect(validateGraphSiteId('contoso.sharepoint.com:/sites/Speedwave:')).toBeNull();
    });

    it('rejects https URL', () => {
      const err = validateGraphSiteId('https://contoso.sharepoint.com/sites/Speedwave');
      expect(err).toContain('must be a Graph site id, not a URL');
      expect(err).toContain('composite');
      expect(err).toContain('path form');
    });

    it('rejects http URL', () => {
      const err = validateGraphSiteId('http://contoso.sharepoint.com/sites/Speedwave');
      expect(err).toContain('must be a Graph site id, not a URL');
    });

    it('rejects mixed-case scheme', () => {
      const err = validateGraphSiteId('HTTPS://contoso.sharepoint.com/sites/Speedwave');
      expect(err).toContain('must be a Graph site id, not a URL');
    });

    it('rejects value with whitespace', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com, guid, guid');
      expect(err).toContain('whitespace');
    });

    it('rejects value with tab character', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com\t,guid,guid');
      expect(err).toContain('whitespace');
    });

    it('rejects empty string', () => {
      const err = validateGraphSiteId('');
      expect(err).toContain('empty');
    });

    it('rejects control characters', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com\x01:/sites/X:');
      expect(err).toContain('control characters');
    });

    it('rejects query string', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com:/sites/X:?leak=1');
      expect(err).toContain('query');
    });

    it('rejects fragment', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com:/sites/X:#frag');
      expect(err).toContain('fragment');
    });

    it('rejects path traversal segment', () => {
      const err = validateGraphSiteId('contoso.sharepoint.com:/sites/../Other:');
      expect(err).toContain('"..".');
    });

    it('rejects non-ASCII (IDN homograph)', () => {
      // Cyrillic 'е' (U+0435) in place of ASCII 'e' in "speednet"
      const err = validateGraphSiteId('speednеtpl.sharepoint.com:/sites/X:');
      expect(err).toContain('ASCII');
    });

    it('rejects RTL override character', () => {
      const err = validateGraphSiteId('acme.sharepoint.com‮:/sites/X:');
      expect(err).toContain('ASCII');
    });
  });

  describe('resolveCompositeSiteId', () => {
    it('passes composite-form site_id through unchanged (no lookup)', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      const composite = 'contoso.sharepoint.com,guid1,guid2';
      await expect(resolveCompositeSiteId(composite, 'tok')).resolves.toEqual({
        ok: true,
        compositeId: composite,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('looks up path-form via Graph and returns the composite id', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'contoso.sharepoint.com,site-guid,web-guid' }),
      }) as unknown as typeof fetch;
      await expect(
        resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok')
      ).resolves.toEqual({
        ok: true,
        compositeId: 'contoso.sharepoint.com,site-guid,web-guid',
      });
    });

    it('reports `not_found` reason on 4xx Graph responses', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
      if (!result.ok) {
        expect(result.detail).toContain('404');
      }
    });

    it('reports `transient` reason on 429 / 5xx', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }) as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'transient' });
    });

    it('reports `not_found` when Graph response lacks a string id', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('rejects non-string `id` field (defends against malformed Graph response)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 42 }),
      }) as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('reports `network` reason on fetch rejection', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'network' });
      if (!result.ok) {
        expect(result.detail).toContain('boom');
      }
    });

    it('retries with refreshed access_token on initial 401', async () => {
      // Cold-start scenario: /tokens/access_token is stale because the worker
      // restarted long after the last activity. Without the refresh path,
      // resolveCompositeSiteId would fail permanently — sharepoint container
      // crashes with "401 Unauthorized" and never recovers (verified live).
      const fetchMock = vi
        .fn()
        // First call returns 401 with the stale bearer.
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        })
        // Refresh succeeds → /tokens/access_token has a fresh bearer.
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'contoso.sharepoint.com,site-guid,web-guid' }),
        });
      global.fetch = fetchMock as unknown as typeof fetch;
      mockOauthRefresh.mockResolvedValueOnce({
        expiresIn: 3600,
        grantedScopes: ['https://graph.microsoft.com/Sites.Manage.All'],
      });
      mockLoadToken.mockResolvedValueOnce('a-fresh');

      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'a-stale', {
        tokensDir: '/test/tokens',
      });
      expect(result).toEqual({
        ok: true,
        compositeId: 'contoso.sharepoint.com,site-guid,web-guid',
      });
      // Refresh path: first fetch with stale token, then refresh, then retry
      // with the fresh bearer.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]).toMatchObject({
        headers: { Authorization: 'Bearer a-fresh' },
      });
    });

    it('logs and continues when proactive refresh during init fails with a non-Error value', async () => {
      // resolveCompositeSiteId triggers a refresh on first-call 401 (cold-start
      // path). If oauth.refresh throws a plain string the catch must still log
      // a usable warning instead of crashing on `e.message` and aborting init.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        // First call: stale 401.
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });
      global.fetch = fetchMock as unknown as typeof fetch;
      mockOauthRefresh.mockRejectedValueOnce('non-error string failure');

      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'stale-tok', {
        refreshOn401: true,
      });

      // Fell through to the standard 401 → not_found branch.
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
      // The non-Error value made it into the warning message verbatim.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-error string failure'));
      warnSpy.mockRestore();
    });

    it('passes an AbortSignal to the cold-start fetch (timeout guard against hangs)', async () => {
      // Pre-fix the cold-start fetch had no timeout — a hung Graph response
      // would block initializeSharePointClient indefinitely and starve the
      // hub's discovery retry budget. The signal proves the AbortController
      // is wired up; the actual timeout behavior is exercised by the
      // dedicated "aborts and returns transient" test below.
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'contoso.sharepoint.com,site-guid,web-guid' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('https://graph.microsoft.com/v1.0/sites/'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('returns transient/timeout when the cold-start fetch aborts', async () => {
      const fetchMock = vi.fn().mockImplementation(() => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok');
      expect(result).toMatchObject({
        ok: false,
        reason: 'transient',
        detail: expect.stringMatching(/timed out after \d+ms/),
      });
    });

    it('also guards the post-401-refresh retry with an AbortSignal', async () => {
      // After a 401 → refresh, the retry must carry the same timeout — pre-fix
      // only the initial fetch had one.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'contoso.sharepoint.com,site,web' }),
        });
      global.fetch = fetchMock as unknown as typeof fetch;
      mockOauthRefresh.mockResolvedValueOnce({ expiresIn: 3600, grantedScopes: [] });
      mockLoadToken.mockResolvedValueOnce('fresh-after-refresh');

      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'stale-tok', {
        refreshOn401: true,
      });

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ signal: expect.any(AbortSignal) });
    });

    it('does not retry on 401 when refreshOn401:false is passed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('contoso.sharepoint.com:/sites/X:', 'tok', {
        refreshOn401: false,
      });
      expect(result).toMatchObject({ ok: false, reason: 'not_found' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockOauthRefresh).not.toHaveBeenCalled();
    });

    it('rejects URL site_id without making a network call (defence in depth)', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      const result = await resolveCompositeSiteId('https://contoso.sharepoint.com/sites/X', 'tok');
      expect(result).toMatchObject({ ok: false, reason: 'validation' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects malformed site_id mixing composite (`,`) and path (`:`) separators', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      const result = await resolveCompositeSiteId(
        'contoso.sharepoint.com:/sites/X,guid,guid',
        'tok'
      );
      expect(result).toMatchObject({ ok: false, reason: 'validation' });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
