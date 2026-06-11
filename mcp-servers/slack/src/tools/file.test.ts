/**
 * File Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RefreshLock } from '@speedwave/mcp-shared';
import { handleGetFileContent, createFileTools } from './file-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    getFileContent: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

import * as client from '../client.js';

function presentClients(): SlackClients {
  return {
    user: {} as never,
    tokenState: { accessToken: 'xoxp-test' },
    lock: new RefreshLock(),
    _tokensStatus: 'present',
  };
}

function unconfiguredClients(): SlackClients {
  return {
    user: {} as never,
    tokenState: { accessToken: '' },
    lock: new RefreshLock(),
    _tokensStatus: 'missing',
  };
}

describe('file-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleGetFileContent', () => {
    it('returns file content on success', async () => {
      const mockFile = {
        id: 'F1',
        name: 'podsumowanie.md',
        mimetype: 'text/markdown',
        size: 11,
        content: '# Heading',
        truncated: false,
      };
      vi.mocked(client.getFileContent).mockResolvedValue(mockFile);

      const result = await handleGetFileContent(presentClients(), { file: 'F1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockFile);
    });

    it('returns READ_FAILED on errors (e.g. binary refusal)', async () => {
      vi.mocked(client.getFileContent).mockRejectedValue(
        new Error("File 'screen.png' is image/png — only text files can be read inline.")
      );

      const result = await handleGetFileContent(presentClients(), { file: 'F2' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('READ_FAILED');
      expect(result.error?.message).toContain('image/png');
    });
  });

  describe('createFileTools', () => {
    it('registers getFileContent with required metadata', () => {
      const tools = createFileTools(presentClients());
      expect(tools.map((t) => t.tool.name)).toEqual(['getFileContent']);
      const tool = tools[0].tool;
      expect(tool.inputSchema.required).toEqual(['file']);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool._meta?.deferLoading).toBe(true);
    });

    it('returns NOT_CONFIGURED when the worker has no token', async () => {
      const tools = createFileTools(unconfiguredClients());
      const handler = tools[0].handler;

      const result = await handler({ file: 'F1' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('NOT_CONFIGURED');
    });
  });
});
