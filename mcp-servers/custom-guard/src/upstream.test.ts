import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient, type McpClientOptions } from '@speedwave/mcp-shared';
import {
  createFixedUpstream,
  createRelayUpstream,
  defaultClientFactory,
  ENDPOINT_FILE,
  parseRelayEndpoint,
  TOKEN_FILE,
} from './upstream.js';

const RELAY_URL = 'http://host.docker.internal:41000/';
const TOKEN = 'relay-token-0123456789abcdef';

describe('parseRelayEndpoint', () => {
  it('returns the URL of an available relay', () => {
    expect(parseRelayEndpoint(JSON.stringify({ url: RELAY_URL, available: true }))).toBe(RELAY_URL);
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['unavailable', JSON.stringify({ url: RELAY_URL, available: false })],
    ['availability missing', JSON.stringify({ url: RELAY_URL })],
    ['url missing', JSON.stringify({ available: true })],
    ['public URL', JSON.stringify({ url: 'http://evil.example:80/', available: true })],
    ['https URL', JSON.stringify({ url: 'https://host.docker.internal:1/', available: true })],
    [
      'URL with a path',
      JSON.stringify({ url: 'http://host.docker.internal:1/x', available: true }),
    ],
  ])('rejects %s', (_label, text) => {
    expect(parseRelayEndpoint(text)).toBeNull();
  });
});

describe('createFixedUpstream', () => {
  it('builds one client with the launcher URL and bearer', () => {
    const factory = vi.fn((options: McpClientOptions) => new McpClient(options));
    const source = createFixedUpstream('http://mcp-custom-x-up:3000/', 'launcher-token', factory);
    const first = source.resolve();
    const second = source.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toMatchObject({
      url: 'http://mcp-custom-x-up:3000/',
      authToken: 'launcher-token',
    });
    expect(first.ok && second.ok && first.client === second.client).toBe(true);
  });

  it('defaults to the real MCP client', () => {
    const source = createFixedUpstream('http://mcp-custom-x-up:3000/', 'launcher-token');
    const resolved = source.resolve();
    expect(resolved.ok && resolved.client instanceof McpClient).toBe(true);
    expect(defaultClientFactory({ url: RELAY_URL })).toBeInstanceOf(McpClient);
  });
});

describe('createRelayUpstream', () => {
  let dir: string;
  const factory = vi.fn((options: McpClientOptions) => new McpClient(options));

  function writeEndpoint(value: unknown): void {
    writeFileSync(join(dir, ENDPOINT_FILE), JSON.stringify(value));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guard-relay-'));
    factory.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is unavailable without endpoint files', () => {
    expect(createRelayUpstream(dir, factory).resolve()).toEqual({
      ok: false,
      reason: 'relay-unavailable',
    });
  });

  it('resolves a client for an available relay with a valid token', () => {
    writeEndpoint({ url: RELAY_URL, available: true });
    writeFileSync(join(dir, TOKEN_FILE), `${TOKEN}\n`);
    const resolved = createRelayUpstream(dir, factory).resolve();
    expect(resolved.ok).toBe(true);
    expect(factory.mock.calls[0][0]).toMatchObject({ url: RELAY_URL, authToken: TOKEN });
  });

  it('re-reads the files on every request and rebuilds the client only on change', () => {
    writeEndpoint({ url: RELAY_URL, available: true });
    writeFileSync(join(dir, TOKEN_FILE), TOKEN);
    const source = createRelayUpstream(dir, factory);
    const first = source.resolve();
    const again = source.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.ok && again.ok && first.client === again.client).toBe(true);

    writeEndpoint({ url: 'http://host.docker.internal:42000/', available: true });
    const moved = source.resolve();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(moved.ok && first.ok && moved.client !== first.client).toBe(true);

    writeEndpoint({ url: 'http://host.docker.internal:42000/', available: false });
    expect(source.resolve().ok).toBe(false);
  });

  it.each([
    ['too short', 'short'],
    ['with whitespace inside', 'relay token with spaces 0123'],
    ['empty', ''],
  ])('rejects a relay token that is %s', (_label, token) => {
    writeEndpoint({ url: RELAY_URL, available: true });
    writeFileSync(join(dir, TOKEN_FILE), token);
    expect(createRelayUpstream(dir, factory).resolve().ok).toBe(false);
  });

  it('is unavailable when the token file disappears', () => {
    writeEndpoint({ url: RELAY_URL, available: true });
    writeFileSync(join(dir, TOKEN_FILE), TOKEN);
    const source = createRelayUpstream(dir, factory);
    expect(source.resolve().ok).toBe(true);
    unlinkSync(join(dir, TOKEN_FILE));
    expect(source.resolve().ok).toBe(false);
  });

  it('ignores an oversized endpoint file', () => {
    writeFileSync(join(dir, ENDPOINT_FILE), ' '.repeat(5000));
    writeFileSync(join(dir, TOKEN_FILE), TOKEN);
    expect(createRelayUpstream(dir, factory).resolve().ok).toBe(false);
  });
});
