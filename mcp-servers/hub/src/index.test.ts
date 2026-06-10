import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import { JSONRPCHandler } from '@speedwave/mcp-shared';
import { createHubApp, createSessionRateLimiter } from './index.js';

/**
 * Helper: start app on a random port, return base URL and server handle.
 */
async function startApp(app: Express): Promise<{ baseUrl: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe('createHubApp', () => {
  let rpcHandler: JSONRPCHandler;
  let server: Server | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    rpcHandler = new JSONRPCHandler({ name: 'hub-test', version: '1.0.0' });
    rpcHandler.registerTool(
      {
        name: 'echo',
        description: 'Echo back',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      async (args) => ({ content: [{ type: 'text' as const, text: String(args.msg ?? '') }] })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('POST notification returns 202', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(res.status).toBe(202);
  });

  it('POST regular request returns 200 JSON', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result).toEqual({});
  });

  it('POST batch returns array response', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(1);
    expect(body[1].id).toBe(2);
  });

  it('DELETE with valid session returns 204', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': '550e8400-e29b-41d4-a716-446655440000' },
    });

    expect(res.status).toBe(204);
  });

  it('DELETE without session returns 400', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl, { method: 'DELETE' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing');
  });

  it('GET / returns 405 with Allow header', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(baseUrl);

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
    const body = await res.json();
    expect(body.error).toBe('Method Not Allowed');
  });

  it('error handling returns 500 JSON-RPC error', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    // Force processRequest to throw
    rpcHandler.processRequest = vi.fn().mockRejectedValue(new Error('Boom'));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toBe('Internal server error');
  });

  it('GET /health returns ok', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const res = await fetch(`${baseUrl}/health`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('POST over the per-session limit returns 429 with Retry-After', async () => {
    const app = createHubApp(rpcHandler);
    const { baseUrl, server: s } = await startApp(app);
    server = s;

    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const send = () =>
      fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

    // First 100 requests in the window pass.
    for (let i = 0; i < 100; i++) {
      const ok = await send();
      expect(ok.status).toBe(200);
    }

    // 101st request in the same window is rejected.
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    const body = await limited.json();
    expect(body.error).toBe('Too Many Requests');
  });
});

describe('createSessionRateLimiter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function mockRes(): Response & {
    statusCode?: number;
    body?: unknown;
    headers: Map<string, string>;
  } {
    const headers = new Map<string, string>();
    const res = {
      headers,
      setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
      status(code: number) {
        (this as { statusCode?: number }).statusCode = code;
        return this;
      },
      json(payload: unknown) {
        (this as { body?: unknown }).body = payload;
        return this;
      },
    };
    return res as unknown as Response & {
      statusCode?: number;
      body?: unknown;
      headers: Map<string, string>;
    };
  }

  function mockReq(headers: Record<string, string>, ip = '10.0.0.1'): Request {
    return {
      method: 'POST',
      ip,
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;
  }

  it('passes requests under the limit and increments the bucket', () => {
    const limiter = createSessionRateLimiter();
    const req = mockReq({ 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' });
    let calls = 0;
    const next: NextFunction = () => {
      calls++;
    };
    for (let i = 0; i < 100; i++) {
      limiter(req, mockRes(), next);
    }
    expect(calls).toBe(100);
  });

  it('rejects the request that exceeds the limit with 429', () => {
    const limiter = createSessionRateLimiter();
    const req = mockReq({ 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' });
    const next: NextFunction = vi.fn();
    for (let i = 0; i < 100; i++) {
      limiter(req, mockRes(), next);
    }
    const res = mockRes();
    limiter(req, res, next);
    expect(res.statusCode).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.body).toEqual({ error: 'Too Many Requests' });
    expect(next).toHaveBeenCalledTimes(100);
  });

  it('keys separate sessions into independent buckets', () => {
    const limiter = createSessionRateLimiter();
    const a = mockReq({ 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440000' });
    const b = mockReq({ 'mcp-session-id': '550e8400-e29b-41d4-a716-446655440001' });
    const next: NextFunction = vi.fn();
    for (let i = 0; i < 100; i++) limiter(a, mockRes(), next);
    // Session A is now at the limit; session B still has a fresh bucket.
    const resB = mockRes();
    limiter(b, resB, next);
    expect(resB.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(101);
  });

  it('falls back to client IP when no session header is present', () => {
    const limiter = createSessionRateLimiter();
    const req = mockReq({}, '192.0.2.5');
    const next: NextFunction = vi.fn();
    for (let i = 0; i < 100; i++) limiter(req, mockRes(), next);
    const res = mockRes();
    limiter(req, res, next);
    expect(res.statusCode).toBe(429);
  });

  it('falls back to "unknown" when neither session nor IP is available', () => {
    const limiter = createSessionRateLimiter();
    const req = { method: 'POST', ip: undefined, get: () => undefined } as unknown as Request;
    const next: NextFunction = vi.fn();
    limiter(req, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
