/**
 * Tests for AtlassianClient — auth header, per-request retry policy, error
 * formatting (secret-safe), connectivity, and `initializeAtlassianClient`.
 *
 * `axios` is mocked: `axios.create()` returns a fake instance whose `request`
 * is a `vi.fn()` we script per test. `axios.isAxiosError` is preserved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosRequestConfig } from 'axios';

// ── axios mock ─────────────────────────────────────────────────────────────
// `vi.mock` factories are hoisted above module-level `const`s, so the mock
// functions must come from `vi.hoisted()` to be referenceable inside them.
const { requestMock, createMock, readCredentialsMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  createMock: vi.fn(),
  readCredentialsMock: vi.fn(),
}));

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  createMock.mockImplementation(() => ({ request: requestMock }));
  return {
    default: {
      create: createMock,
      isAxiosError: actual.default.isAxiosError,
    },
    AxiosError: actual.AxiosError,
  };
});

// ── auth mock (for initializeAtlassianClient) ──────────────────────────────
vi.mock('./auth.js', () => ({
  readCredentials: () => readCredentialsMock(),
}));

import { AtlassianClient, initializeAtlassianClient } from './client.js';
import { ScopeError } from './adf.js';
import type { AtlassianConfig } from './types.js';

const CONFIG: AtlassianConfig = {
  siteUrl: 'https://acme.atlassian.net',
  email: 'bot@acme.com',
  apiToken: 'ATATT3xSecretToken',
  jiraProjectKeys: [],
  confluenceSpaceKeys: [],
};

/** Build an axios-style error with a `response`. */
function httpError(status: number, data?: unknown, headers?: Record<string, string>): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: true;
    response: { status: number; data: unknown; headers: Record<string, string> };
    config: AxiosRequestConfig;
  };
  err.isAxiosError = true;
  err.response = { status, data, headers: headers ?? {} };
  err.config = {
    baseURL: 'https://acme.atlassian.net',
    headers: { Authorization: 'Basic ZXZpbA==' },
  };
  return err;
}

/** Build an axios-style network error (no `response`). */
function networkError(code = 'ECONNREFUSED'): Error {
  const err = new Error('connect ECONNREFUSED') as Error & {
    isAxiosError: true;
    code: string;
    config: AxiosRequestConfig;
  };
  err.isAxiosError = true;
  err.code = code;
  err.config = {
    baseURL: 'https://acme.atlassian.net',
    headers: { Authorization: 'Basic ZXZpbA==' },
  };
  return err;
}

beforeEach(() => {
  requestMock.mockReset();
  createMock.mockClear();
  readCredentialsMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Make jitter deterministic-ish: backoff() uses Math.random — pin to 0 so
  // retries don't actually sleep long. We still advance timers manually.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('construction', () => {
  it('configures axios with the Basic auth header derived from email:token', () => {
    new AtlassianClient(CONFIG);
    const expected = `Basic ${Buffer.from('bot@acme.com:ATATT3xSecretToken').toString('base64')}`;
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://acme.atlassian.net',
        maxRedirects: 0,
        headers: expect.objectContaining({ Authorization: expected }),
      })
    );
  });

  it('exposes the configured allowlists', () => {
    const c = new AtlassianClient({
      ...CONFIG,
      jiraProjectKeys: ['PROJ'],
      confluenceSpaceKeys: ['DEV'],
    });
    expect(c.jiraProjectKeys).toEqual(['PROJ']);
    expect(c.confluenceSpaceKeys).toEqual(['DEV']);
  });
});

describe('request — happy path', () => {
  it('returns the response body for a GET', async () => {
    requestMock.mockResolvedValueOnce({ data: { ok: true } });
    const c = new AtlassianClient(CONFIG);
    await expect(c.get('/rest/api/3/myself')).resolves.toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/rest/api/3/myself' })
    );
  });

  it('passes data through for a POST', async () => {
    requestMock.mockResolvedValueOnce({ data: { id: '1' } });
    const c = new AtlassianClient(CONFIG);
    await expect(c.post('/x', { a: 1 })).resolves.toEqual({ id: '1' });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: '/x', data: { a: 1 } })
    );
  });
});

describe('request — retry policy', () => {
  it('GET retries a transient 5xx then succeeds', async () => {
    vi.useFakeTimers();
    requestMock.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('GET gives up after MAX_RETRIES on persistent 5xx', async () => {
    vi.useFakeTimers();
    requestMock.mockRejectedValue(httpError(500));
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    // initial try + 3 retries
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it('POST does NOT retry a 5xx (write — surfaces immediately)', async () => {
    requestMock.mockRejectedValueOnce(httpError(502));
    const c = new AtlassianClient(CONFIG);
    await expect(c.post('/x', {})).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('PUT does NOT retry a 5xx', async () => {
    requestMock.mockRejectedValueOnce(httpError(500));
    const c = new AtlassianClient(CONFIG);
    await expect(c.put('/x', {})).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('POST retries a 429 (rate limit is safe to replay)', async () => {
    vi.useFakeTimers();
    requestMock.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.post('/x', {});
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('honours a numeric Retry-After header on 429', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    requestMock
      .mockRejectedValueOnce(httpError(429, undefined, { 'retry-after': '2' }))
      .mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  it('honours an HTTP-date Retry-After header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    requestMock
      .mockRejectedValueOnce(
        httpError(429, undefined, { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' })
      )
      .mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('ignores a malformed Retry-After and falls back to backoff', async () => {
    vi.useFakeTimers();
    requestMock
      .mockRejectedValueOnce(httpError(429, undefined, { 'retry-after': 'soon' }))
      .mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx other than 429', async () => {
    requestMock.mockRejectedValueOnce(httpError(404));
    const c = new AtlassianClient(CONFIG);
    await expect(c.get('/x')).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-axios error', async () => {
    requestMock.mockRejectedValueOnce(new Error('boom'));
    const c = new AtlassianClient(CONFIG);
    await expect(c.get('/x')).rejects.toThrow('boom');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('post({ retryable: true }) retries a 5xx (idempotent search via POST)', async () => {
    vi.useFakeTimers();
    requestMock.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.post('/rest/api/3/search/jql', {}, { retryable: true });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('del() issues a DELETE and does not retry 5xx', async () => {
    requestMock.mockRejectedValueOnce(httpError(500));
    const c = new AtlassianClient(CONFIG);
    await expect(c.del('/x')).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', url: '/x' })
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('request() with no method/url logs a GET-shaped retry line', async () => {
    vi.useFakeTimers();
    requestMock.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.request<string>({}, { retryable: true });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('429 retry on a request whose error has no headers object', async () => {
    vi.useFakeTimers();
    const err = httpError(429) as Error & { response: { headers?: unknown } };
    delete err.response.headers;
    requestMock.mockRejectedValueOnce(err).mockResolvedValueOnce({ data: 'ok' });
    const c = new AtlassianClient(CONFIG);
    const p = c.get('/x');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});

describe('testConnection', () => {
  it('returns success on a 2xx /myself', async () => {
    requestMock.mockResolvedValueOnce({ data: { accountId: 'x' } });
    const c = new AtlassianClient(CONFIG);
    await expect(c.testConnection()).resolves.toEqual({ success: true });
  });

  it('returns a formatted error on failure', async () => {
    requestMock.mockRejectedValueOnce(httpError(401));
    const c = new AtlassianClient(CONFIG);
    const res = await c.testConnection();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/authentication failed/i);
  });
});

describe('formatError', () => {
  it('passes a ScopeError message through verbatim', () => {
    expect(AtlassianClient.formatError(new ScopeError('nope, PROJ only'))).toBe('nope, PROJ only');
  });

  it('401 → auth guidance', () => {
    expect(AtlassianClient.formatError(httpError(401))).toMatch(/authentication failed/i);
  });

  it('403 → permission message', () => {
    expect(AtlassianClient.formatError(httpError(403))).toMatch(/permission denied/i);
  });

  it('404 → not found, includes API message when present', () => {
    expect(
      AtlassianClient.formatError(httpError(404, { errorMessages: ['Issue does not exist'] }))
    ).toMatch(/Issue does not exist/);
    expect(AtlassianClient.formatError(httpError(404))).toMatch(/not found/i);
  });

  it('429 → rate limit message', () => {
    expect(AtlassianClient.formatError(httpError(429))).toMatch(/rate limit/i);
  });

  it('other 4xx → request error with API message (errors map)', () => {
    expect(
      AtlassianClient.formatError(httpError(400, { errors: { summary: 'is required' } }))
    ).toMatch(/is required/);
  });

  it('other 4xx → request error with .message field', () => {
    expect(AtlassianClient.formatError(httpError(409, { message: 'conflict' }))).toMatch(
      /conflict/
    );
  });

  it('5xx → server error', () => {
    expect(AtlassianClient.formatError(httpError(500))).toMatch(/server error/i);
  });

  it('network error → reachability message with host only (no Authorization)', () => {
    const msg = AtlassianClient.formatError(networkError('ETIMEDOUT'));
    expect(msg).toMatch(/acme\.atlassian\.net/);
    expect(msg).toMatch(/ETIMEDOUT/);
    expect(msg).not.toMatch(/Basic/);
  });

  it('network error with no usable baseURL falls back to "Atlassian"', () => {
    const err = networkError() as Error & { config: AxiosRequestConfig };
    err.config = { baseURL: 'not a url', headers: {} };
    expect(AtlassianClient.formatError(err)).toMatch(/Atlassian/);
  });

  it('network error with a non-string baseURL falls back to "Atlassian"', () => {
    const err = networkError() as Error & { config: AxiosRequestConfig };
    err.config = { baseURL: 123 as unknown as string, headers: {} };
    expect(AtlassianClient.formatError(err)).toMatch(/Atlassian/);
  });

  it('network error with missing config', () => {
    const err = networkError() as Error & { config?: AxiosRequestConfig };
    delete err.config;
    expect(AtlassianClient.formatError(err)).toMatch(/Atlassian/);
  });

  it('network error with no error code omits the code suffix', () => {
    const err = networkError() as Error & { code?: string };
    delete err.code;
    const msg = AtlassianClient.formatError(err);
    expect(msg).toMatch(/unable to reach acme\.atlassian\.net/);
    expect(msg).not.toMatch(/\(undefined\)/);
  });

  it('plain Error → scrubbed message', () => {
    const msg = AtlassianClient.formatError(
      new Error('failed with Basic Zm9vOmJhcg== and ATATT3xLEAKEDtoken')
    );
    expect(msg).not.toMatch(/Zm9vOmJhcg==/);
    expect(msg).not.toMatch(/ATATT3xLEAKEDtoken/);
    expect(msg).toMatch(/REDACTED/);
  });

  it('non-Error value → scrubbed string', () => {
    expect(AtlassianClient.formatError('boom: ATATT3xANOTHERtoken')).toMatch(
      /REDACTED_ATLASSIAN_TOKEN/
    );
  });

  it('axios 4xx with no status fields and no body', () => {
    const err = httpError(418);
    expect(AtlassianClient.formatError(err)).toMatch(/418/);
  });
});

describe('initializeAtlassianClient', () => {
  it('returns null when credentials are missing', async () => {
    readCredentialsMock.mockResolvedValueOnce(null);
    await expect(initializeAtlassianClient()).resolves.toBeNull();
  });

  it('returns null when the connection test fails', async () => {
    readCredentialsMock.mockResolvedValueOnce(CONFIG);
    requestMock.mockRejectedValueOnce(httpError(401));
    await expect(initializeAtlassianClient()).resolves.toBeNull();
  });

  it('returns the client on a successful connection test', async () => {
    readCredentialsMock.mockResolvedValueOnce(CONFIG);
    requestMock.mockResolvedValueOnce({ data: { accountId: 'x' } });
    const client = await initializeAtlassianClient();
    expect(client).toBeInstanceOf(AtlassianClient);
  });

  it('returns null and logs (scrubbed) when readCredentials throws', async () => {
    readCredentialsMock.mockRejectedValueOnce(new Error('disk on fire near ATATT3xOOPStoken'));
    await expect(initializeAtlassianClient()).resolves.toBeNull();
  });
});
