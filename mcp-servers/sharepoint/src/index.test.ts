import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createMCPServerMock, initializeSharePointClientMock, retryAsyncMock } = vi.hoisted(() => ({
  createMCPServerMock: vi.fn(),
  initializeSharePointClientMock: vi.fn(),
  retryAsyncMock: vi.fn(),
}));

vi.mock('@speedwave/mcp-shared', async () => {
  const actual =
    await vi.importActual<typeof import('@speedwave/mcp-shared')>('@speedwave/mcp-shared');
  return {
    ...actual,
    createMCPServer: createMCPServerMock,
    retryAsync: retryAsyncMock,
  };
});

vi.mock('./client.js', () => ({
  initializeSharePointClient: initializeSharePointClientMock,
}));

const flushPromises = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('MCP SharePoint Server', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv, MCP_SHAREPOINT_AUTH_TOKEN: 'test-token' };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Default: retryAsync passes through to the fn it receives (simulates immediate success)
    retryAsyncMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('health check succeeds when no token save error', async () => {
    const startMock = vi.fn().mockResolvedValue(3002);
    createMCPServerMock.mockReturnValue({ start: startMock });

    const mockClient = {
      getHealthStatus: vi.fn().mockReturnValue({ tokenSaveError: null }),
    };
    initializeSharePointClientMock.mockResolvedValue(mockClient);

    await import('./index.js');
    await flushPromises();

    const config = createMCPServerMock.mock.calls[0][0];
    await expect(config.healthCheck()).resolves.toBeUndefined();
  });

  it('health check throws when token refresh has failed', async () => {
    const startMock = vi.fn().mockResolvedValue(3002);
    createMCPServerMock.mockReturnValue({ start: startMock });

    const mockClient = {
      getHealthStatus: vi.fn().mockReturnValue({ tokenSaveError: 'EACCES: permission denied' }),
    };
    initializeSharePointClientMock.mockResolvedValue(mockClient);

    await import('./index.js');
    await flushPromises();

    const config = createMCPServerMock.mock.calls[0][0];
    await expect(config.healthCheck()).rejects.toThrow('Token refresh failed');
  });

  it('calls process.exit(1) when retryAsync exhausts and client is null', async () => {
    // retryAsync returns null after exhaustion -> SharePoint fail-fast triggers process.exit(1)
    retryAsyncMock.mockResolvedValue(null);

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as typeof process.exit);

    await import('./index.js');
    await flushPromises();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
