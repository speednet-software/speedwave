import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'http';
import { JSONRPCHandler } from '@speedwave/mcp-shared';
import { createHubApp } from './index.js';

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
});
