import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  StdioBridge,
  BridgeClosedError,
  BridgeAbortedError,
  DEFAULT_MAX_LINE_BYTES,
} from './stdio-bridge.js';

const FAKE_SERVER = fileURLToPath(new URL('../test/fixtures/fake-server.mjs', import.meta.url));

const bridges: StdioBridge[] = [];

function start(options: { maxLineBytes?: number; command?: string; args?: string[] } = {}) {
  let resolveExit: (value: [number | null, NodeJS.Signals | null]) => void = () => undefined;
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = vi.fn((code: number | null, signal: NodeJS.Signals | null) =>
    resolveExit([code, signal])
  );
  const bridge = new StdioBridge({
    command: options.command ?? process.execPath,
    args: options.args ?? [FAKE_SERVER],
    env: { PATH: process.env.PATH ?? '', SECRET_KEY: 'value-123' },
    ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}),
    onExit,
  });
  bridges.push(bridge);
  return { bridge, onExit, exited };
}

function call(
  bridge: StdioBridge,
  id: string | number,
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal
) {
  return bridge.request(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    signal
  );
}

function payload(response: Record<string, unknown>): unknown {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.kill('SIGKILL');
});

describe('StdioBridge', () => {
  it('restores the caller id on the response', async () => {
    const { bridge } = start();
    const response = await call(bridge, 'caller-7', 'echo', { a: 1 });
    expect(response.id).toBe('caller-7');
    expect(payload(response)).toEqual({ a: 1 });
    expect(bridge.running).toBe(true);
  });

  it('keeps concurrent requests with the same caller id apart', async () => {
    const { bridge } = start();
    const delays = [60, 10, 40, 0, 25, 5, 50, 15];
    const responses = await Promise.all(
      delays.map((delayMs, n) => call(bridge, 1, 'echo', { n, delayMs }))
    );
    responses.forEach((response, n) => {
      expect(response.id).toBe(1);
      expect(payload(response)).toEqual({ n, delayMs: delays[n] });
    });
  });

  it('passes only the given environment to the child', async () => {
    const { bridge } = start();
    const keys = payload(await call(bridge, 1, 'envkeys')) as string[];
    expect(keys).toContain('SECRET_KEY');
    const platformAdded =
      /^(PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|__CF_USER_TEXT_ENCODING|LC_CTYPE)$/i;
    for (const inherited of Object.keys(process.env)) {
      if (!platformAdded.test(inherited)) expect(keys).not.toContain(inherited);
    }
  });

  it.each(['sampling/createMessage', 'elicitation/create', 'roots/list', 'tools/list'])(
    'refuses the server-initiated request %s',
    async (method) => {
      const { bridge } = start();
      const answer = payload(await call(bridge, 1, 'ask', { method })) as Record<string, unknown>;
      expect(answer.id).toMatch(/^srv-/);
      expect(answer.error).toEqual({
        code: -32601,
        message: 'Speedwave does not support requests from the server to the client',
      });
    }
  );

  it('answers a server ping', async () => {
    const { bridge } = start();
    const answer = payload(await call(bridge, 1, 'ask', { method: 'ping' })) as Record<
      string,
      unknown
    >;
    expect(answer.result).toEqual({});
  });

  it('ignores non-JSON lines, notifications and unknown ids', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bridge } = start();
    const response = await call(bridge, 5, 'noise');
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'after noise' }] });
    await call(bridge, 6, 'noise');
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((l) => l.includes('non-JSON'))).toHaveLength(1);
    expect(logged.join('\n')).not.toContain('not json at all');
    errors.mockRestore();
  });

  it('reassembles a response split inside a multi-byte character', async () => {
    const { bridge } = start();
    const response = await call(bridge, 1, 'split');
    expect(response.result).toEqual({ content: [{ type: 'text', text: 'zażółć 😀' }] });
  });

  it('forwards notifications while the child runs', async () => {
    const { bridge } = start();
    bridge.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const stats = payload(await call(bridge, 1, 'stats')) as { initializedCount: number };
    expect(stats.initializedCount).toBe(1);
  });

  it('cancels an abandoned request and tells the child', async () => {
    const { bridge } = start();
    const controller = new AbortController();
    const pending = call(bridge, 1, 'hang', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BridgeAbortedError);
    const stats = payload(await call(bridge, 2, 'stats')) as { cancelled: number[] };
    expect(stats.cancelled).toHaveLength(1);
    controller.abort();
  });

  it('ignores an abort after the response arrived', async () => {
    const { bridge } = start();
    const controller = new AbortController();
    await call(bridge, 1, 'echo', {}, controller.signal);
    controller.abort();
    const stats = payload(await call(bridge, 2, 'stats')) as { cancelled: number[] };
    expect(stats.cancelled).toEqual([]);
  });

  it('fails pending requests and reports the exit when the child dies', async () => {
    const { bridge, onExit, exited } = start();
    const hanging = call(bridge, 1, 'hang', {}, new AbortController().signal);
    const dying = call(bridge, 2, 'die', { code: 7 });
    await expect(dying).rejects.toBeInstanceOf(BridgeClosedError);
    await expect(hanging).rejects.toBeInstanceOf(BridgeClosedError);
    expect(await exited).toEqual([7, null]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(bridge.running).toBe(false);
    await expect(call(bridge, 3, 'echo')).rejects.toBeInstanceOf(BridgeClosedError);
    bridge.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    bridge.kill();
  });

  it('kills a child that writes an oversized line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bridge, exited } = start({ maxLineBytes: 1024 });
    const pending = call(bridge, 1, 'long', { size: 4096 });
    await expect(pending).rejects.toBeInstanceOf(BridgeClosedError);
    expect((await exited)[1]).toBe('SIGKILL');
    expect(errors.mock.calls.some((c) => String(c[0]).includes('longer than 1024 bytes'))).toBe(
      true
    );
    errors.mockRestore();
  });

  it('reports a command that cannot be started', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bridge, exited } = start({
      command: '/nonexistent/spw-launcher-test-binary',
      args: [],
    });
    expect(await exited).toEqual([null, null]);
    expect(bridge.running).toBe(false);
    await expect(call(bridge, 1, 'echo')).rejects.toBeInstanceOf(BridgeClosedError);
    errors.mockRestore();
  });

  it('survives a broken stdin pipe', async () => {
    const { bridge } = start();
    const stdin = (bridge as unknown as { child: { stdin: NodeJS.WritableStream } }).child.stdin;
    expect(() => stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    expect((await call(bridge, 1, 'echo', { still: 'up' })).id).toBe(1);
  });

  it('has a 16 MiB default line cap', () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });
});
