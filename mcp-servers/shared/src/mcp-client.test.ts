import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  McpClient,
  McpClientError,
  parseSseData,
  DEFAULT_MAX_LIST_PAGES,
  type McpClientOptions,
} from './mcp-client.js';
import { LATEST_PROTOCOL_VERSION } from './types.js';

interface Received {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}

type Responder = (message: Record<string, unknown>, received: Received[]) => Reply | undefined;

let server: http.Server;
let url: string;
let received: Received[];
let responder: Responder;

function json(id: unknown, result: unknown, headers: Record<string, string> = {}): Reply {
  return {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function initResult(id: unknown, sessionId: string | null = 'session-1'): Reply {
  return json(
    id,
    {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      serverInfo: { name: 'up', version: '1' },
    },
    sessionId ? { 'mcp-session-id': sessionId } : {}
  );
}

function standard(overrides: Partial<Record<string, Responder>> = {}): Responder {
  return (message, all) => {
    const method = String(message.method);
    const override = overrides[method];
    if (override) return override(message, all);
    if (method === 'initialize') return initResult(message.id);
    if (method === 'notifications/initialized') return { status: 202 };
    if (method === 'ping') return json(message.id, {});
    if (method === 'tools/list') return json(message.id, { tools: [{ name: 'a' }] });
    if (method === 'tools/call')
      return json(message.id, { content: [{ type: 'text', text: 'ok' }] });
    return { status: 500 };
  };
}

function client(options: Partial<McpClientOptions> = {}): McpClient {
  return new McpClient({ url, authToken: 'secret-token', ...options });
}

function methods(): Array<string | undefined> {
  return received.map((r) => r.method);
}

async function expectKind(promise: Promise<unknown>, kind: string): Promise<McpClientError> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(McpClientError);
  expect((error as McpClientError).kind).toBe(kind);
  return error as McpClientError;
}

beforeEach(async () => {
  received = [];
  responder = standard();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      received.push({
        method: message.method as string | undefined,
        id: message.id,
        params: message.params as Record<string, unknown> | undefined,
        headers: req.headers,
      });
      const reply = responder(message, received) ?? { status: 500 };
      const send = () => {
        res.writeHead(reply.status ?? 200, reply.headers ?? {});
        res.end(reply.body ?? '');
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('McpClient handshake and headers', () => {
  it('initializes once, then sends session, protocol and bearer headers', async () => {
    const c = client();
    expect(await c.callTool('a', { x: 1 })).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(methods()).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    const [init, notified, call] = received;
    expect(init.headers.authorization).toBe('Bearer secret-token');
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(init.headers.accept).toBe('application/json, text/event-stream');
    expect(init.params).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      clientInfo: { name: 'speedwave', version: '1.0.0' },
    });
    expect(notified.headers['mcp-session-id']).toBe('session-1');
    expect(notified.id).toBeUndefined();
    expect(call.headers['mcp-session-id']).toBe('session-1');
    expect(call.headers['mcp-protocol-version']).toBe(LATEST_PROTOCOL_VERSION);
    expect(call.params).toEqual({ name: 'a', arguments: { x: 1 } });
  });

  it('works without a bearer and without a session id', async () => {
    responder = standard({ initialize: (m) => initResult(m.id, null) });
    const c = new McpClient({ url, clientInfo: { name: 'guard', version: '2' } });
    await c.ping();
    expect(received[2].headers.authorization).toBeUndefined();
    expect(received[2].headers['mcp-session-id']).toBeUndefined();
    expect(received[0].params?.clientInfo).toEqual({ name: 'guard', version: '2' });
    expect(await c.initialize()).toEqual({ protocolVersion: LATEST_PROTOCOL_VERSION });
  });

  it('shares one handshake between concurrent first calls', async () => {
    responder = standard({ initialize: (m) => ({ ...initResult(m.id), delayMs: 30 }) });
    const c = client();
    await Promise.all([c.ping(), c.callTool('a', {}), c.listTools()]);
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('retries the handshake on the next call after a failed one', async () => {
    let fail = true;
    responder = standard({
      initialize: (m) => (fail ? { status: 503 } : initResult(m.id)),
    });
    const c = client();
    const error = await expectKind(c.ping(), 'http');
    expect(error.details.status).toBe(503);
    fail = false;
    await c.ping();
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(2);
  });

  it.each([
    ['missing protocolVersion', (id: unknown) => json(id, {})],
    ['non-object result', (id: unknown) => json(id, 'x')],
    ['unsupported protocolVersion', (id: unknown) => json(id, { protocolVersion: '1999-01-01' })],
    [
      'invalid session id',
      (id: unknown) =>
        json(id, { protocolVersion: LATEST_PROTOCOL_VERSION }, { 'mcp-session-id': 'has space' }),
    ],
  ])('rejects an initialize with %s', async (_name, reply) => {
    responder = standard({ initialize: (m) => reply(m.id) });
    await expectKind(client().ping(), 'protocol');
  });

  it('rejects an initialize answered with a JSON-RPC error', async () => {
    responder = standard({
      initialize: (m) => ({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32600, message: 'nope' },
        }),
      }),
    });
    const error = await expectKind(client().initialize(), 'rpc');
    expect(error.details.rpcCode).toBe(-32600);
  });

  it('fails when notifications/initialized is rejected', async () => {
    responder = standard({ 'notifications/initialized': () => ({ status: 400, body: 'bad' }) });
    const error = await expectKind(client().ping(), 'http');
    expect(error.message).toContain('notifications/initialized');
  });
});

describe('McpClient session recovery', () => {
  it('re-initializes once when the server forgot the session (404)', async () => {
    let calls = 0;
    responder = standard({
      'tools/call': (m) =>
        ++calls === 1 ? { status: 404, body: '' } : json(m.id, { content: [] }),
      initialize: (m, all) =>
        initResult(m.id, `session-${all.filter((r) => r.method === 'initialize').length}`),
    });
    const c = client();
    expect(await c.callTool('a', {})).toEqual({ content: [] });
    expect(methods()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(received[5].headers['mcp-session-id']).toBe('session-2');
  });

  it('re-initializes on a 400 "not initialized" and on a 404 naming the session', async () => {
    let calls = 0;
    responder = standard({
      initialize: (m) => initResult(m.id, null),
      ping: (m) => {
        calls++;
        if (calls === 1) return { status: 400, body: 'Bad Request: Server not initialized' };
        if (calls === 3) return { status: 404, body: 'Session not found' };
        return json(m.id, {});
      },
    });
    const c = client();
    await c.ping();
    await c.ping();
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(3);
  });

  it('re-initializes once for concurrent requests that all lost the session', async () => {
    let calls = 0;
    responder = standard({
      'tools/call': (m) => (++calls <= 2 ? { status: 404, body: '' } : json(m.id, { content: [] })),
    });
    const c = client();
    await c.initialize();
    await Promise.all([c.callTool('a', {}), c.callTool('b', {})]);
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(2);
  });

  it('gives up after one re-initialization', async () => {
    responder = standard({ 'tools/call': () => ({ status: 404, body: 'gone' }) });
    const error = await expectKind(client().callTool('a', {}), 'http');
    expect(error.details.status).toBe(404);
    expect(methods().filter((m) => m === 'tools/call')).toHaveLength(2);
  });

  it('does not re-initialize on an unrelated 400 or on other statuses', async () => {
    responder = standard({ 'tools/call': () => ({ status: 400, body: 'bad arguments' }) });
    await expectKind(client().callTool('a', {}), 'http');
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
    responder = standard({ ping: () => ({ status: 500, body: 'boom' }) });
    await expectKind(client().ping(), 'http');
  });

  it('does not re-initialize on a 404 without session id or session wording', async () => {
    responder = standard({
      initialize: (m) => initResult(m.id, null),
      ping: () => ({ status: 404, body: 'nope' }),
    });
    await expectKind(client().ping(), 'http');
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
  });

  it('treats an oversized error body as not a session failure', async () => {
    responder = standard({
      initialize: (m) => initResult(m.id, null),
      ping: () => ({ status: 400, body: 'not initialized '.repeat(1000) }),
    });
    await expectKind(client().ping(), 'http');
    expect(methods().filter((m) => m === 'initialize')).toHaveLength(1);
  });
});

describe('McpClient responses', () => {
  it('reads SSE responses with multi-line data and skips other events', async () => {
    responder = standard({
      'tools/call': (m) => ({
        headers: { 'content-type': 'text/event-stream' },
        body:
          ': keep-alive\r\n\r\n' +
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
          'data: {"jsonrpc":"2.0","id":"other","result":{}}\n\n' +
          `data:{"jsonrpc":"2.0",\ndata: "id":${JSON.stringify(m.id)},\ndata: "result":{"content":[]}}\n`,
      }),
    });
    expect(await client().callTool('a', {})).toEqual({ content: [] });
  });

  it('reads a batch response', async () => {
    responder = standard({
      ping: (m) => ({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', method: 'notifications/message' },
          { jsonrpc: '2.0', id: m.id, result: {} },
        ]),
      }),
    });
    await client().ping();
  });

  it.each([
    ['non-JSON body', () => ({ body: 'hello' })],
    ['empty body', () => ({ body: '' })],
    ['no content (204)', () => ({ status: 204 })],
    ['mismatched id', () => json('another-id', {})],
    [
      'missing jsonrpc',
      (m: Record<string, unknown>) => ({ body: JSON.stringify({ id: m.id, result: {} }) }),
    ],
    [
      'neither result nor error',
      (m: Record<string, unknown>) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: m.id }) }),
    ],
  ])('rejects a response with %s', async (_name, reply) => {
    responder = standard({ ping: (m) => reply(m) });
    await expectKind(client().ping(), 'protocol');
  });

  it('surfaces JSON-RPC errors with a bounded message', async () => {
    responder = standard({
      'tools/call': (m) => ({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32602, message: 'x'.repeat(500) },
        }),
      }),
    });
    const error = await expectKind(client().callTool('a', {}), 'rpc');
    expect(error.details.rpcCode).toBe(-32602);
    expect(error.message.length).toBeLessThan(250);
  });

  it('handles a JSON-RPC error without code or message', async () => {
    responder = standard({
      ping: (m) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: m.id, error: {} }) }),
    });
    const error = await expectKind(client().ping(), 'rpc');
    expect(error.message).toContain('unknown error');
    expect(error.details.rpcCode).toBeUndefined();
  });

  it('fails a body above the size cap and accepts one at the cap', async () => {
    const result = { content: [{ type: 'text', text: 'y'.repeat(1000) }] };
    responder = standard({ 'tools/call': (m) => json(m.id, result) });
    const size = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(36), result }));
    expect(await client({ maxResponseBytes: size }).callTool('a', {})).toEqual(result);
    await expectKind(client({ maxResponseBytes: size - 1 }).callTool('a', {}), 'too-large');
  });

  it('never follows redirects', async () => {
    responder = standard({
      ping: () => ({ status: 302, headers: { location: 'http://example.com/' } }),
    });
    const error = await expectKind(client().ping(), 'network');
    expect(error.message).toContain('MCP request failed');
    expect(methods().filter((m) => m === 'ping')).toHaveLength(1);
  });

  it('times out slow responses', async () => {
    responder = standard({ ping: (m) => ({ ...json(m.id, {}), delayMs: 300 }) });
    const c = client();
    await c.initialize();
    await expectKind(c.ping({ timeoutMs: 50 }), 'timeout');
  });

  it('honours caller cancellation', async () => {
    responder = standard({ ping: (m) => ({ ...json(m.id, {}), delayMs: 300 }) });
    const c = client();
    await c.initialize();
    const controller = new AbortController();
    const pending = c.ping({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expectKind(pending, 'network');
  });

  it('maps a non-Error transport failure', async () => {
    const c = client({ fetch: (() => Promise.reject('down')) as unknown as typeof fetch });
    const error = await expectKind(c.ping(), 'network');
    expect(error.message).toContain('down');
  });

  it('maps a failure while reading the body', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    let first = true;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const message = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (message.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: LATEST_PROTOCOL_VERSION },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (message.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      if (first) {
        first = false;
        return new Response(broken, { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}');
    }) as unknown as typeof fetch;
    const error = await expectKind(client({ fetch: fakeFetch }).ping(), 'network');
    expect(error.message).toContain('socket reset');
  });
});

describe('McpClient.listTools', () => {
  it('follows cursors across pages', async () => {
    responder = standard({
      'tools/list': (m) => {
        const cursor = m.params && (m.params as Record<string, unknown>).cursor;
        if (!cursor) return json(m.id, { tools: [{ name: 'a' }], nextCursor: 'p2' });
        if (cursor === 'p2') return json(m.id, { tools: [{ name: 'b' }], nextCursor: 'p3' });
        return json(m.id, { tools: [{ name: 'c' }], nextCursor: null });
      },
    });
    expect(await client().listTools()).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  it('stops at the page cap', async () => {
    let n = 0;
    responder = standard({ 'tools/list': (m) => json(m.id, { tools: [], nextCursor: `c${n++}` }) });
    const error = await expectKind(client({ maxListPages: 3 }).listTools(), 'protocol');
    expect(error.message).toContain('exceeded 3 pages');
    expect(methods().filter((m) => m === 'tools/list')).toHaveLength(3);
    expect(DEFAULT_MAX_LIST_PAGES).toBe(50);
  });

  it.each([
    ['a repeated cursor', (id: unknown) => json(id, { tools: [], nextCursor: 'same' })],
    ['a non-string cursor', (id: unknown) => json(id, { tools: [], nextCursor: 7 })],
    ['no tools array', (id: unknown) => json(id, { tools: {} })],
    ['a non-object result', (id: unknown) => json(id, null)],
  ])('rejects %s', async (_name, reply) => {
    responder = standard({ 'tools/list': (m) => reply(m.id) });
    await expectKind(client().listTools(), 'protocol');
  });

  it('returns an empty list for an empty cursor', async () => {
    responder = standard({ 'tools/list': (m) => json(m.id, { tools: [], nextCursor: '' }) });
    expect(await client().listTools()).toEqual([]);
  });
});

describe('parseSseData', () => {
  it('joins multi-line data, strips one leading space and ignores other fields', () => {
    expect(parseSseData('id: 1\nevent: x\ndata:  two spaces\ndata\nretry: 5\n\ndata: b')).toEqual([
      ' two spaces\n',
      'b',
    ]);
  });

  it('returns nothing for an empty stream or comments only', () => {
    expect(parseSseData('')).toEqual([]);
    expect(parseSseData(': ping\n\n')).toEqual([]);
  });

  it('keeps Unicode payloads intact', () => {
    expect(parseSseData('data: {"t":"zażółć 😀"}\r\n\r\n')).toEqual(['{"t":"zażółć 😀"}']);
  });
});
