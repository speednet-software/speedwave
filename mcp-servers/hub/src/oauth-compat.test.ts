import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { JSONRPCHandler } from '@speedwave/mcp-shared';
import { createOAuthCompatHandler, OAUTH_COMPAT_PATH } from './oauth-compat.js';
import { createHubApp } from './index.js';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(payload: unknown): this {
    this.body = payload;
    this.emit('close');
    return this;
  }
}

const CALLER_TOKEN = 'oauth-compat-test-token';

const refreshCall = {
  id: 'req-1',
  method: 'tools/call',
  params: { name: 'refresh', arguments: {} },
};

function call(handler: ReturnType<typeof createOAuthCompatHandler>, body: unknown): FakeResponse {
  const res = new FakeResponse();
  handler({ body } as Request, res as unknown as Response);
  return res;
}

describe('createOAuthCompatHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a refresh call only after the wait, in the shape the old client accepts', async () => {
    const handler = createOAuthCompatHandler({ waitMs: 15_000 });
    const res = call(handler, refreshCall);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(res.body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { content: [{ type: 'text', text: '{"expiresIn":0,"grantedScopes":[]}' }] },
    });
  });

  it('waits 15 s by default', async () => {
    const handler = createOAuthCompatHandler();
    const res = call(handler, refreshCall);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(res.body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(res.body).toBeDefined();
  });

  it('echoes a null id when the request has none', async () => {
    const handler = createOAuthCompatHandler({ waitMs: 10 });
    const res = call(handler, { method: 'tools/call', params: { name: 'refresh' } });
    await vi.advanceTimersByTimeAsync(10);
    expect(res.body).toMatchObject({ id: null });
  });

  it.each([
    ['a missing body', undefined],
    ['another method', { id: 1, method: 'tools/list' }],
    ['another tool', { id: 1, method: 'tools/call', params: { name: 'forget' } }],
    ['no params', { id: 1, method: 'tools/call' }],
  ])('rejects %s with 400 and does not wait', (_label, body) => {
    const handler = createOAuthCompatHandler({ waitMs: 10 });
    const res = call(handler, body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request' });
  });

  it('rejects calls above the concurrent limit with 429 and admits them again after a slot frees', async () => {
    const handler = createOAuthCompatHandler({ waitMs: 100, maxWaiting: 2 });
    const first = call(handler, refreshCall);
    const second = call(handler, refreshCall);
    const third = call(handler, refreshCall);
    expect(third.statusCode).toBe(429);
    expect(third.body).toEqual({ error: 'Too Many Requests' });
    await vi.advanceTimersByTimeAsync(100);
    expect(first.body).toBeDefined();
    expect(second.body).toBeDefined();
    const fourth = call(handler, refreshCall);
    await vi.advanceTimersByTimeAsync(100);
    expect(fourth.statusCode).toBe(200);
    expect(fourth.body).toBeDefined();
  });

  it('frees the slot and never answers when the client disconnects while waiting', async () => {
    const handler = createOAuthCompatHandler({ waitMs: 100, maxWaiting: 1 });
    const gone = call(handler, refreshCall);
    gone.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    expect(gone.body).toBeUndefined();
    const next = call(handler, refreshCall);
    expect(next.statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(100);
    expect(next.body).toBeDefined();
  });
});

describe('oauth compat endpoint in the hub app', () => {
  let dir: string;
  let server: Server | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-compat-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function start(rpcHandler: JSONRPCHandler, waitMs: number): Promise<void> {
    const tokenPath = join(dir, 'caller-token');
    await writeFile(tokenPath, CALLER_TOKEN);
    const app = createHubApp(rpcHandler, { waitMs }, tokenPath);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  }

  async function oldPluginRefresh(
    url: string,
    bearerPath: string,
    tokenPath: string
  ): Promise<{ expiresIn: number; grantedScopes: string[]; token: string }> {
    const bearer = (await readFile(bearerPath, 'utf8')).trim();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'abc',
        method: 'tools/call',
        params: { name: 'refresh', arguments: {} },
      }),
    });
    if (!response.ok) throw new Error(`oauth worker HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: { content: Array<{ text?: string }>; isError?: boolean };
    };
    const text = body.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { expiresIn?: unknown; grantedScopes?: unknown };
    if (typeof payload.expiresIn !== 'number' || !Array.isArray(payload.grantedScopes)) {
      throw new Error(`unexpected oauth response shape: ${text}`);
    }
    const token = (await readFile(tokenPath, 'utf8')).trim();
    return {
      expiresIn: payload.expiresIn,
      grantedScopes: payload.grantedScopes.map(String),
      token,
    };
  }

  it('answers a client in the shape of the old glpi copy, which then reads the rewritten token', async () => {
    const bearerPath = join(dir, 'oauth-auth-token-glpi');
    const tokenPath = join(dir, 'access_token');
    await writeFile(bearerPath, 'bearer-from-old-mount');
    await writeFile(tokenPath, 'old-token');
    await start(new JSONRPCHandler({ name: 'hub-test', version: '1.0.0' }), 50);

    const pending = oldPluginRefresh(`${baseUrl}${OAUTH_COMPAT_PATH}`, bearerPath, tokenPath);
    await writeFile(tokenPath, 'token-the-host-wrote');
    const result = await pending;

    expect(result).toEqual({ expiresIn: 0, grantedScopes: [], token: 'token-the-host-wrote' });
  });

  it('does not list the endpoint or a refresh tool in the hub tool registry', async () => {
    const rpcHandler = new JSONRPCHandler({ name: 'hub-test', version: '1.0.0' });
    rpcHandler.registerTool(
      { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: {} } },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    );
    await start(rpcHandler, 10);

    const list = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-speedwave-proxy-auth': CALLER_TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listed = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(['echo']);

    const call = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-speedwave-proxy-auth': CALLER_TOKEN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'refresh', arguments: {} },
      }),
    });
    const called = (await call.json()) as { error?: unknown; result?: unknown };
    expect(called.error).toBeDefined();
  });
});
