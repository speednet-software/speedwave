import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createMCPServerMock, initializeSharePointClientMock } = vi.hoisted(() => ({
  createMCPServerMock: vi.fn(),
  initializeSharePointClientMock: vi.fn(),
}));

vi.mock('../../shared/dist/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/dist/index.js')>(
    '../../shared/dist/index.js'
  );
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
    process.env = { ...originalEnv };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('health check succeeds when no token save error', async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
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
    const startMock = vi.fn().mockResolvedValue(undefined);
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
