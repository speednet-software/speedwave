import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createToolDefinitions } from './tools/index.js';
import type { GeminiClient } from './client.js';

const { createMCPServerMock, initializeGeminiClientMock } = vi.hoisted(() => ({
  createMCPServerMock: vi.fn(),
  initializeGeminiClientMock: vi.fn(),
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
  initializeGeminiClient: initializeGeminiClientMock,
}));

const flushPromises = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('MCP Gemini Server', () => {
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

  it('creates MCP server with chat tool and health check when configured', async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    createMCPServerMock.mockReturnValue({ start: startMock });

    const mockClient = {
      isInitialized: vi.fn().mockReturnValue(true),
      chat: vi.fn(),
    } as unknown as GeminiClient;

    initializeGeminiClientMock.mockResolvedValue(mockClient);
    process.env.PORT = '4010';
    process.env.WORKSPACE_DIR = '/tmp/workspace';

    await import('./index.js');
    await flushPromises();

    expect(createMCPServerMock).toHaveBeenCalledTimes(1);
    const config = createMCPServerMock.mock.calls[0][0];

    expect(config.name).toBe('mcp-gemini');
    expect(config.version).toBe('1.0.0');
    expect(config.port).toBe(4010);

    const expectedTools = createToolDefinitions(mockClient);
    expect(config.tools).toHaveLength(expectedTools.length);
    expect(config.tools[0].tool).toEqual(expectedTools[0].tool);
    expect(typeof config.tools[0].handler).toBe('function');

    expect(config.tools[0].tool.inputSchema.required).toContain('prompt');
    expect(config.tools[0].tool.inputSchema.required).not.toContain('outputFormat');
    expect(config.tools[0].tool.inputSchema.properties.outputFormat.enum).toEqual([
      'text',
      'json',
      'markdown',
    ]);

    await expect(config.healthCheck()).resolves.toBeUndefined();

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('health check throws when client is null', async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    createMCPServerMock.mockReturnValue({ start: startMock });

    initializeGeminiClientMock.mockResolvedValue(null);

    await import('./index.js');
    await flushPromises();

    const config = createMCPServerMock.mock.calls[0][0];
    await expect(config.healthCheck()).rejects.toThrow('Gemini client not initialized');
  });
});
