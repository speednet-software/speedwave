import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createMCPServerMock, initializeSharePointClientMock } = vi.hoisted(() => ({
  createMCPServerMock: vi.fn(),
  initializeSharePointClientMock: vi.fn(),
}));

vi.mock('@speedwave/mcp-shared', async () => {
  const actual =
    await vi.importActual<typeof import('@speedwave/mcp-shared')>('@speedwave/mcp-shared');
  return {
    ...actual,
    createMCPServer: createMCPServerMock,
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
});
