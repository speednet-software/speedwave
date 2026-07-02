import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { bootWorkerMock } = vi.hoisted(() => ({ bootWorkerMock: vi.fn() }));

vi.mock('@speedwave/mcp-shared', async () => {
  const actual =
    await vi.importActual<typeof import('@speedwave/mcp-shared')>('@speedwave/mcp-shared');
  return {
    ...actual,
    bootWorker: bootWorkerMock,
  };
});

vi.mock('./client.js', () => ({
  initializeSharePointClient: vi.fn(),
}));

const flushPromises = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('MCP SharePoint Server entry', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv, MCP_SHAREPOINT_AUTH_TOKEN: 'test-token' };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    bootWorkerMock.mockResolvedValue(3002);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('boots with SharePoint fail-fast policy and the auth env', async () => {
    await import('./index.js');
    await flushPromises();

    const opts = bootWorkerMock.mock.calls[0][0];
    expect(opts.serverName).toBe('mcp-sharepoint');
    expect(opts.displayName).toBe('SharePoint');
    expect(opts.authTokenEnv).toBe('MCP_SHAREPOINT_AUTH_TOKEN');
    expect(opts.onNotConfigured).toBe('fail');
    expect(opts.host).toBe('0.0.0.0');
  });

  it('health check resolves when there is no token-save error', async () => {
    await import('./index.js');
    await flushPromises();

    const opts = bootWorkerMock.mock.calls[0][0];
    const client = { getHealthStatus: vi.fn().mockReturnValue({ tokenSaveError: null }) };
    await expect(opts.makeHealthCheck(client)()).resolves.toBeUndefined();
  });

  it('health check throws when token refresh has failed', async () => {
    await import('./index.js');
    await flushPromises();

    const opts = bootWorkerMock.mock.calls[0][0];
    const client = {
      getHealthStatus: vi.fn().mockReturnValue({ tokenSaveError: 'EACCES: permission denied' }),
    };
    await expect(opts.makeHealthCheck(client)()).rejects.toThrow('Token refresh failed');
  });

  it('health check throws when the connection resolve failed', async () => {
    await import('./index.js');
    await flushPromises();

    const opts = bootWorkerMock.mock.calls[0][0];
    const client = {
      getHealthStatus: vi
        .fn()
        .mockReturnValue({ connection: 'failed', connectionError: 'site not found' }),
    };
    await expect(opts.makeHealthCheck(client)()).rejects.toThrow(
      /SharePoint siteId resolve failed/
    );
  });

  it('exits when bootWorker rejects (fatal-error trap)', async () => {
    bootWorkerMock.mockRejectedValue(new Error('Unexpected crash'));
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as typeof process.exit);

    await import('./index.js');
    await flushPromises();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Fatal error'),
      expect.any(Error)
    );
  });
});
