import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  buildChildEnv,
  CHILD_ENV_PASSTHROUGH,
  DEFAULT_ENTRY_PATH,
  DEFAULT_MAX_BODY_BYTES,
  FORBIDDEN_ENV_KEYS,
  isForbiddenEnvKey,
  LauncherConfigError,
  loadConfig,
  main,
  readEntry,
  readTokenEnv,
  startLauncher,
  type LauncherConfig,
  type LauncherHandle,
} from './launcher.js';

const FAKE_SERVER = fileURLToPath(new URL('../test/fixtures/fake-server.mjs', import.meta.url));
const TOKEN = 'launcher-bearer-0123456789';

let dir: string;
let handles: LauncherHandle[];

function writeEntry(content: unknown, name = 'entry.json'): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function tokensDir(files: Record<string, string>): string {
  const tokens = path.join(dir, 'tokens');
  mkdirSync(tokens, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(tokens, name), value);
  return tokens;
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SPW_LAUNCHER_AUTH_TOKEN: TOKEN,
    SPW_LAUNCHER_ENTRY: writeEntry({ command: process.execPath, args: [FAKE_SERVER] }),
    TOKENS_DIR: path.join(dir, 'no-tokens'),
    PORT: '0',
    MCP_LISTEN_HOST: '127.0.0.1',
    PATH: process.env.PATH,
    ...overrides,
  };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

function request(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/',
        headers: options.headers ?? {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function rpc(
  port: number,
  message: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  return request(port, { body: JSON.stringify(message), ...(headers ? { headers } : {}) });
}

function callTool(port: number, id: unknown, name: string, args: Record<string, unknown> = {}) {
  return rpc(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

function toolPayload(result: HttpResult): unknown {
  const content = (result.json().result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text);
}

async function launch(overrides: Partial<LauncherConfig> = {}, onExit = vi.fn()) {
  const config: LauncherConfig = {
    ...loadConfig(baseEnv()),
    ...overrides,
  };
  const handle = await startLauncher(config, onExit);
  handles.push(handle);
  return { port: handle.port, onExit, handle };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'spw-launcher-'));
  handles = [];
});

afterEach(async () => {
  for (const handle of handles) await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('readEntry', () => {
  it('reads command and args', () => {
    expect(
      readEntry(writeEntry({ command: 'node', args: ['server.js', '--stdio', 'zażółć'] }))
    ).toEqual({
      command: 'node',
      args: ['server.js', '--stdio', 'zażółć'],
    });
    expect(readEntry(writeEntry({ command: 'x', args: [] }))).toEqual({ command: 'x', args: [] });
  });

  it.each([
    ['missing file', null, /cannot read entry file/],
    ['invalid JSON', '{', /not valid JSON/],
    ['array', '[]', /JSON object/],
    ['unknown keys', { command: 'x', args: [], env: {} }, /unknown keys: env/],
    ['empty command', { command: '', args: [] }, /entry.command/],
    ['NUL in command', { command: 'a\u0000b', args: [] }, /entry.command/],
    ['numeric command', { command: 5, args: [] }, /entry.command/],
    ['missing args', { command: 'x' }, /entry.args/],
    ['non-string arg', { command: 'x', args: [1] }, /entry.args/],
    ['NUL in arg', { command: 'x', args: ['a\u0000'] }, /entry.args/],
    ['too many args', { command: 'x', args: Array.from({ length: 257 }, () => 'a') }, /entry.args/],
  ])('rejects %s', (_name, content, message) => {
    const file = content === null ? path.join(dir, 'absent.json') : writeEntry(content);
    expect(() => readEntry(file)).toThrow(message);
  });

  it('rejects an oversized entry file', () => {
    const file = writeEntry({ command: 'x', args: ['a'.repeat(70 * 1024)] });
    expect(() => readEntry(file)).toThrow(/larger than/);
  });
});

describe('readTokenEnv', () => {
  it('reads env-shaped files, trims values and skips everything else', () => {
    const tokens = tokensDir({
      FIGMA_API_KEY: '  secret-value\n',
      EMPTY: '',
      lowercase: 'skip',
      '.hidden': 'skip',
      '_settings.json': '{}',
      'WITH-DASH': 'skip',
    });
    mkdirSync(path.join(tokens, 'SUBDIR'));
    symlinkSync(path.join(tokens, 'FIGMA_API_KEY'), path.join(tokens, 'LINKED'));
    expect(readTokenEnv(tokens)).toEqual({ FIGMA_API_KEY: 'secret-value', EMPTY: '' });
  });

  it('returns nothing for a missing directory', () => {
    expect(readTokenEnv(path.join(dir, 'missing'))).toEqual({});
  });

  it('fails on an unreadable directory path', () => {
    const file = path.join(dir, 'file');
    writeFileSync(file, 'x');
    expect(() => readTokenEnv(file)).toThrow(/cannot read token directory/);
  });

  it.each([
    ...FORBIDDEN_ENV_KEYS,
    'NPM_CONFIG_REGISTRY',
    'PIP_INDEX_URL',
    'SPW_LAUNCHER_AUTH_TOKEN',
  ])('refuses a token file named %s without logging its value', (name) => {
    const tokens = tokensDir({ [name]: 'do-not-log-me' });
    let message = '';
    try {
      readTokenEnv(tokens);
    } catch (error) {
      expect(error).toBeInstanceOf(LauncherConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain('do-not-log-me');
  });

  it('refuses NUL bytes and oversized values', () => {
    expect(() => readTokenEnv(tokensDir({ BAD: 'a\u0000b' }))).toThrow(/NUL byte/);
    rmSync(path.join(dir, 'tokens'), { recursive: true });
    expect(() => readTokenEnv(tokensDir({ BIG: 'x'.repeat(65 * 1024) }))).toThrow(/larger than/);
  });
});

describe('isForbiddenEnvKey', () => {
  it.each([
    ['NODE_OPTIONS', true],
    ['HTTPS_PROXY', true],
    ['NPM_CONFIG_', true],
    ['PIP_TRUSTED_HOST', true],
    ['SPW_ANYTHING', true],
    ['FIGMA_TOKEN', false],
    ['NODE_ENV', false],
    ['PIPE_SIZE', false],
  ])('%s -> %s', (name, expected) => {
    expect(isForbiddenEnvKey(name)).toBe(expected);
  });
});

describe('buildChildEnv', () => {
  it('passes the allowlisted launcher env and the credentials, never the bearer', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://egress:3128',
        no_proxy: '',
        NODE_USE_ENV_PROXY: '1',
        TZ: 'Europe/Warsaw',
        SPW_LAUNCHER_AUTH_TOKEN: TOKEN,
        PORT: '3000',
        TOKENS_DIR: '/tokens',
        AWS_SECRET_ACCESS_KEY: 'leak',
      },
      { FIGMA_TOKEN: 'abc', TZ: 'UTC' }
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://egress:3128',
      no_proxy: '',
      NODE_USE_ENV_PROXY: '1',
      TZ: 'UTC',
      FIGMA_TOKEN: 'abc',
    });
    expect(CHILD_ENV_PASSTHROUGH).not.toContain('SPW_LAUNCHER_AUTH_TOKEN');
  });
});

describe('loadConfig', () => {
  it('resolves defaults and reads entry and tokens', () => {
    const config = loadConfig(
      baseEnv({
        PORT: undefined,
        MCP_LISTEN_HOST: undefined,
        TOKENS_DIR: tokensDir({ API_KEY: 'k' }),
      })
    );
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(config.childEnv.API_KEY).toBe('k');
    expect(config.childEnv.SPW_LAUNCHER_AUTH_TOKEN).toBeUndefined();
    expect(DEFAULT_ENTRY_PATH).toBe('/opt/spw/entry.json');
  });

  it.each([
    [
      'missing bearer',
      { SPW_LAUNCHER_AUTH_TOKEN: undefined },
      /SPW_LAUNCHER_AUTH_TOKEN is required/,
    ],
    [
      'blank bearer',
      { SPW_LAUNCHER_AUTH_TOKEN: '        ' },
      /SPW_LAUNCHER_AUTH_TOKEN is required/,
    ],
    ['short bearer', { SPW_LAUNCHER_AUTH_TOKEN: 'short' }, /SPW_LAUNCHER_AUTH_TOKEN is required/],
    ['bad port', { PORT: 'abc' }, /PORT/],
    ['port out of range', { PORT: '70000' }, /PORT/],
    ['negative port', { PORT: '-1' }, /PORT/],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => loadConfig(baseEnv(overrides))).toThrow(message);
  });

  it('reads tokens from /tokens by default', () => {
    const config = loadConfig(baseEnv({ TOKENS_DIR: undefined }));
    expect(Object.keys(config.childEnv).sort()).toEqual(['PATH']);
  });

  it('falls back to the default entry path', () => {
    expect(() => loadConfig(baseEnv({ SPW_LAUNCHER_ENTRY: undefined }))).toThrow(
      /\/opt\/spw\/entry\.json/
    );
  });
});

describe('HTTP endpoint', () => {
  it('serves /health without a bearer and with nothing but the status', async () => {
    const { port } = await launch();
    const res = await request(port, { method: 'GET', path: '/health', headers: {} });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it.each([
    ['no header', {}],
    ['wrong token', { Authorization: 'Bearer wrong-token-0123456789' }],
    ['wrong scheme', { Authorization: `Basic ${TOKEN}` }],
    ['empty bearer', { Authorization: 'Bearer ' }],
    ['token prefix', { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
  ])('rejects %s with 401 before reading the body', async (_name, auth) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { port } = await launch();
    const res = await request(port, {
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(warn.mock.calls.join('\n')).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it('requires the bearer on unknown paths too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { port } = await launch();
    expect((await request(port, { path: '/other', headers: {} })).status).toBe(401);
    expect((await request(port, { method: 'GET', path: '/health?x=1', headers: {} })).status).toBe(
      200
    );
    expect((await request(port, { method: 'POST', path: '/health', headers: {} })).status).toBe(
      401
    );
    warn.mockRestore();
  });

  it('rejects browser origins, unknown paths, other methods and content types', async () => {
    const { port } = await launch();
    const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    expect(
      (await request(port, { headers: { ...auth, Origin: 'http://evil.example' }, body: '{}' }))
        .status
    ).toBe(403);
    expect((await request(port, { path: '/mcp', headers: auth, body: '{}' })).status).toBe(404);
    const get = await request(port, { method: 'GET', headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await request(port, { method: 'DELETE', headers: auth })).status).toBe(405);
    const text = await request(port, {
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(text.status).toBe(415);
    const noType = await request(port, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(noType.status).toBe(415);
  });

  it('enforces the body cap by declared length and by streamed bytes', async () => {
    const { port } = await launch({ maxBodyBytes: 64 });
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'x'.repeat(100) },
    });
    expect(
      (
        await request(port, {
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: big,
        })
      ).status
    ).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.write('x'.repeat(40));
      req.write('x'.repeat(40));
      req.end();
    });
    expect(chunked).toBe(413);
    const declared = await request(port, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(big)),
      },
      body: big,
    });
    expect(declared.status).toBe(413);
    expect(declared.headers.connection).toBe('close');
    const fits = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(fits.length).toBeLessThanOrEqual(64);
    expect((await rpc(port, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{', -32700],
    ['a batch', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600],
    ['a non-object', '"x"', -32600],
    ['a wrong version', '{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600],
    ['an object id', '{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600],
    ['a null id', '{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600],
  ])('answers %s with a JSON-RPC error', async (_name, body, code) => {
    const { port } = await launch();
    const res = await request(port, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(400);
    expect((res.json().error as { code: number }).code).toBe(code);
  });

  it('initializes the child once and serves later initialize calls from cache', async () => {
    const { port } = await launch();
    const init = (id: number) =>
      rpc(port, {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'guard', version: '1' },
        },
      });
    const [first, second] = await Promise.all([init(1), init(2)]);
    const third = await init(3);
    expect(first.json()).toMatchObject({ id: 1, result: { serverInfo: { name: 'fake' } } });
    expect(second.json()).toMatchObject({ id: 2, result: { serverInfo: { name: 'fake' } } });
    expect(third.json()).toMatchObject({ id: 3, result: { protocolVersion: '2025-11-25' } });
    expect(first.headers['mcp-session-id']).toBeUndefined();
    for (let i = 0; i < 2; i++) {
      const notified = await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(notified.status).toBe(202);
    }
    await rpc(port, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    const stats = toolPayload(await callTool(port, 9, 'stats')) as Record<string, number>;
    expect(stats.initializeCount).toBe(1);
    expect(stats.initializedCount).toBe(1);
  });

  it('does not cache a failed initialize', async () => {
    const { port } = await launch();
    const init = (id: number, protocolVersion: string) =>
      rpc(port, { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion } });
    const failed = await init(1, 'fail-once');
    expect(failed.json()).toMatchObject({ id: 1, error: { code: -32602 } });
    const retried = await init(2, '2025-11-25');
    expect(retried.json()).toMatchObject({ id: 2, result: { protocolVersion: '2025-11-25' } });
  });

  it('keeps concurrent calls with colliding ids apart', async () => {
    const { port } = await launch();
    const delays = Array.from({ length: 20 }, (_, n) => (n * 37) % 90);
    const results = await Promise.all(
      delays.map((delayMs, n) => callTool(port, 1, 'echo', { n, delayMs }))
    );
    results.forEach((res, n) => {
      expect(res.status).toBe(200);
      expect(res.json().id).toBe(1);
      expect(toolPayload(res)).toEqual({ n, delayMs: delays[n] });
    });
  });

  it('passes child JSON-RPC errors through and accepts client responses', async () => {
    const { port } = await launch();
    const unknown = await rpc(port, { jsonrpc: '2.0', id: 'q', method: 'resources/list' });
    expect(unknown.json()).toEqual({
      jsonrpc: '2.0',
      id: 'q',
      error: { code: -32601, message: 'Method not found' },
    });
    const response = await rpc(port, { jsonrpc: '2.0', id: 'srv-1', result: {} });
    expect(response.status).toBe(202);
  });

  it.each(['sampling/createMessage', 'elicitation/create', 'roots/list'])(
    'answers the server-initiated %s with an error',
    async (method) => {
      const { port } = await launch();
      const answer = toolPayload(await callTool(port, 1, 'ask', { method })) as Record<
        string,
        unknown
      >;
      expect((answer.error as { code: number }).code).toBe(-32601);
    }
  );

  it('gives the child its credentials and proxy env but never the bearer', async () => {
    const env = baseEnv({
      TOKENS_DIR: tokensDir({ FIGMA_TOKEN: 'figma-secret' }),
      HTTPS_PROXY: 'http://egress:3128',
    });
    const config = loadConfig(env);
    const { port } = await launch(config);
    expect(toolPayload(await callTool(port, 1, 'env', { key: 'FIGMA_TOKEN' }))).toEqual({
      value: 'figma-secret',
    });
    expect(toolPayload(await callTool(port, 2, 'env', { key: 'HTTPS_PROXY' }))).toEqual({
      value: 'http://egress:3128',
    });
    expect(toolPayload(await callTool(port, 3, 'env', { key: 'SPW_LAUNCHER_AUTH_TOKEN' }))).toEqual(
      { value: null }
    );
    expect(toolPayload(await callTool(port, 4, 'env', { key: 'TOKENS_DIR' }))).toEqual({
      value: null,
    });
  });

  it('cancels the child request when the HTTP client goes away', async () => {
    const { port } = await launch();
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      });
      req.on('error', () => resolve());
      req.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang' } })
      );
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stats = toolPayload(await callTool(port, 2, 'stats')) as { cancelled: unknown[] };
    expect(stats.cancelled).toHaveLength(1);
  });

  it('reports the child exit and answers 503 afterwards', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let exited: (code: number | null) => void = () => undefined;
    const exit = new Promise<number | null>((resolve) => {
      exited = resolve;
    });
    const { port, onExit } = await launch(
      {},
      vi.fn((code: number | null) => exited(code))
    );
    const dying = await callTool(port, 1, 'die', { code: 4 });
    expect(dying.status).toBe(503);
    expect(dying.json()).toMatchObject({ id: 1, error: { code: -32603 } });
    expect(await exit).toBe(4);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect((await callTool(port, 2, 'echo')).status).toBe(503);
    expect((await rpc(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(
      202
    );
    errors.mockRestore();
  });

  it('survives a client that disconnects in the middle of the body', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { port } = await launch();
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': '1000',
        },
      });
      req.on('error', () => resolve());
      req.write('{"jsonrpc":');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors.mock.calls.some((c) => String(c[0]).startsWith('request failed'))).toBe(true);
    expect((await callTool(port, 1, 'echo', { ok: true })).status).toBe(200);
    errors.mockRestore();
  });

  it('fails to start on a port that is already taken', async () => {
    const { port } = await launch();
    await expect(launch({ port })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('main', () => {
  it('exits 1 without starting anything when the config is unsafe', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.fn();
    expect(
      await main(baseEnv({ SPW_LAUNCHER_AUTH_TOKEN: '' }), exit, new EventEmitter())
    ).toBeNull();
    expect(exit).toHaveBeenCalledWith(1);
    errors.mockRestore();
  });

  it('exits with the child exit code, or 1 for a clean or signalled exit', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ code: 9 }, 9],
      [{ code: 0 }, 1],
    ];
    for (const [args, expected] of cases) {
      let resolveExit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const handle = await main(baseEnv(), resolveExit, new EventEmitter());
      expect(handle).not.toBeNull();
      handles.push(handle as LauncherHandle);
      await callTool((handle as LauncherHandle).port, 1, 'die', args);
      expect(await exited).toBe(expected);
    }
    errors.mockRestore();
    log.mockRestore();
  });

  it('exits 0 when it was asked to stop', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals = new EventEmitter();
    const handle = await main(baseEnv(), resolveExit, signals);
    expect(handle).not.toBeNull();
    signals.emit('SIGTERM');
    expect(await exited).toBe(0);
    errors.mockRestore();
    log.mockRestore();
  });

  it('exits 1 when the listener cannot bind', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { port } = await launch();
    const exit = vi.fn();
    expect(await main(baseEnv({ PORT: String(port) }), exit, new EventEmitter())).toBeNull();
    expect(exit).toHaveBeenCalledWith(1);
    errors.mockRestore();
  });
});
