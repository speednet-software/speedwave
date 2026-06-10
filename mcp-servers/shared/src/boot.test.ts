import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the server factory so bootWorker never opens a real socket. The mock
// records the options passed so tests can assert the declarative wiring.
const startMock = vi.fn(async () => 4321);
const createMCPServerMock = vi.fn(() => ({ start: startMock }));
vi.mock('./server.js', () => ({
  createMCPServer: (opts: unknown) => createMCPServerMock(opts),
}));

// Mock retryAsync to a single pass-through call — the real one sleeps for
// seconds when initClient resolves null, which would hang these unit tests.
vi.mock('./retry.js', () => ({
  retryAsync: (fn: () => Promise<unknown>) => fn(),
}));

import { bootWorker } from './boot.js';

describe('bootWorker', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    createMCPServerMock.mockClear();
    startMock.mockClear();
    // process.exit throws so the test can assert it short-circuits.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('boots a configured worker: auth gate passes, tools + health wired, port announced', async () => {
    process.env.PORT = '3000';
    process.env.MCP_TEST_AUTH_TOKEN = 'secret';
    const makeTools = vi.fn(() => []);
    const makeHealthCheck = vi.fn(() => async () => {});

    const port = await bootWorker({
      serverName: 'mcp-test',
      version: '1.0.0',
      displayName: 'Test',
      authTokenEnv: 'MCP_TEST_AUTH_TOKEN',
      host: '0.0.0.0',
      initClient: async () => ({ ok: true }),
      makeTools,
      makeHealthCheck,
    });

    expect(port).toBe(4321);
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.name).toBe('mcp-test');
    expect(opts.port).toBe(3000);
    expect(opts.host).toBe('0.0.0.0');
    expect(opts.auth).toEqual({ token: 'secret' });
    expect(makeTools).toHaveBeenCalledWith({ ok: true });
    expect(makeHealthCheck).toHaveBeenCalledWith({ ok: true }, true);
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify({ port: 4321 }) + '\n');
  });

  it('exits when the required auth token env var is missing', async () => {
    delete process.env.MCP_TEST_AUTH_TOKEN;
    await expect(
      bootWorker({
        serverName: 'mcp-test',
        version: '1.0.0',
        authTokenEnv: 'MCP_TEST_AUTH_TOKEN',
        makeTools: () => [],
      })
    ).rejects.toThrow('exit:1');
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('MCP_TEST_AUTH_TOKEN is required');
  });

  it('exits on an invalid PORT value', async () => {
    process.env.PORT = 'not-a-port';
    await expect(
      bootWorker({ serverName: 'mcp-test', version: '1.0.0', makeTools: () => [] })
    ).rejects.toThrow('exit:1');
  });

  it('exits on an out-of-range PORT value', async () => {
    process.env.PORT = '70000';
    await expect(
      bootWorker({ serverName: 'mcp-test', version: '1.0.0', makeTools: () => [] })
    ).rejects.toThrow('exit:1');
  });

  it('defaults displayName to serverName in the not-configured warning', async () => {
    await bootWorker({
      serverName: 'mcp-thing',
      version: '1.0.0',
      initClient: async () => null,
      makeTools: () => [],
    });
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('mcp-thing not configured');
  });

  it('logs client-initialized when init returns a configured client without health check', async () => {
    await bootWorker({
      serverName: 'mcp-test',
      version: '1.0.0',
      displayName: 'Test',
      initClient: async () => ({ ok: true }),
      makeTools: () => [],
    });
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Test client initialized');
  });

  it('defaults the port to 3000 when PORT is unset', async () => {
    delete process.env.PORT;
    await bootWorker({ serverName: 'mcp-test', version: '1.0.0', makeTools: () => [] });
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.port).toBe(3000);
  });

  it('honours defaultPort (os/host-side use "0")', async () => {
    delete process.env.PORT;
    await bootWorker({
      serverName: 'mcp-os',
      version: '1.0.0',
      defaultPort: '0',
      makeTools: () => [],
    });
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.port).toBe(0);
  });

  it('omits host (host-side default) when host is not provided', async () => {
    await bootWorker({ serverName: 'mcp-os', version: '1.0.0', makeTools: () => [] });
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect('host' in opts).toBe(false);
  });

  it('omits auth when no authTokenEnv is given', async () => {
    await bootWorker({ serverName: 'mcp-test', version: '1.0.0', makeTools: () => [] });
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect('auth' in opts).toBe(false);
  });

  it('warns (and continues) when client init returns null and policy is warn', async () => {
    const makeTools = vi.fn(() => []);
    await bootWorker({
      serverName: 'mcp-test',
      version: '1.0.0',
      displayName: 'Test',
      initClient: async () => null,
      onNotConfigured: 'warn',
      makeTools,
    });
    const warnText = warnSpy.mock.calls.flat().join(' ');
    expect(warnText).toContain('Test not configured');
    expect(warnText).toContain('Server will start but tools will return errors');
    expect(makeTools).toHaveBeenCalledWith(null);
  });

  it('fails fast when client init returns null and policy is fail (sharepoint)', async () => {
    await expect(
      bootWorker({
        serverName: 'mcp-sharepoint',
        version: '1.0.0',
        displayName: 'SharePoint',
        initClient: async () => null,
        onNotConfigured: 'fail',
        makeTools: () => [],
      })
    ).rejects.toThrow('exit:1');
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('SharePoint not configured');
  });

  it('uses a custom isConfigured predicate (slack _tokensStatus)', async () => {
    const makeHealthCheck = vi.fn(() => async () => {});
    await bootWorker({
      serverName: 'mcp-slack',
      version: '1.0.0',
      displayName: 'Slack',
      initClient: async () => ({ _tokensStatus: 'missing' }),
      isConfigured: (c) => (c as { _tokensStatus: string })._tokensStatus === 'present',
      makeTools: () => [],
      makeHealthCheck,
    });
    // non-null object but isConfigured=false → warn path, health receives configured=false
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('Slack not configured');
    expect(makeHealthCheck).toHaveBeenCalledWith({ _tokensStatus: 'missing' }, false);
  });

  it('skips client init entirely for credential-free workers (office)', async () => {
    const makeTools = vi.fn(() => []);
    await bootWorker({
      serverName: 'mcp-office',
      version: '1.0.0',
      makeTools,
    });
    expect(makeTools).toHaveBeenCalledWith(null);
    // No "not configured" warning for a worker with no client.
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('not configured');
  });

  it('omits healthCheck when makeHealthCheck is not provided', async () => {
    await bootWorker({ serverName: 'mcp-test', version: '1.0.0', makeTools: () => [] });
    const opts = createMCPServerMock.mock.calls[0][0] as Record<string, unknown>;
    expect('healthCheck' in opts).toBe(false);
  });
});
