/**
 * File Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RefreshLock, META_KEYS, WRITE_ANNOTATIONS } from '@speedwave/mcp-shared';
import {
  handleGetFileContent,
  handleDownloadFile,
  handleUploadFile,
  createFileTools,
} from './file-tools.js';
import type { SlackClients } from '../client.js';

vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    getFileContent: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

import * as client from '../client.js';
import { MAX_UPLOAD_FILES, UploadTransferError } from '../client.js';

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

  describe('handleDownloadFile', () => {
    it('returns the workspace path on success', async () => {
      const saved = {
        id: 'F1',
        name: 'analiza.pdf',
        mimetype: 'application/pdf',
        size: 4,
        path: '/workspace/.speedwave/slack/F1-analiza.pdf',
      };
      vi.mocked(client.downloadFile).mockResolvedValue(saved);

      const result = await handleDownloadFile(presentClients(), { file: 'F1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(saved);
    });

    it('returns DOWNLOAD_FAILED on errors', async () => {
      vi.mocked(client.downloadFile).mockRejectedValue(
        new Error("File 'huge.bin' is 99 bytes — over the download cap.")
      );

      const result = await handleDownloadFile(presentClients(), { file: 'F2' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DOWNLOAD_FAILED');
      expect(result.error?.message).toContain('download cap');
    });
  });

  describe('handleUploadFile', () => {
    it('passes the upload result through on success', async () => {
      const uploaded = {
        ok: true,
        files: [{ id: 'F9', name: 'report.pdf' }],
        channel: 'C1',
      };
      vi.mocked(client.uploadFile).mockResolvedValue(uploaded);

      const result = await handleUploadFile(presentClients(), {
        channel: 'C1',
        filePaths: ['report.pdf'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(uploaded);
      expect(client.uploadFile).toHaveBeenCalledWith(expect.anything(), {
        channel: 'C1',
        filePaths: ['report.pdf'],
      });
    });

    it('returns UPLOAD_FAILED on errors', async () => {
      vi.mocked(client.uploadFile).mockRejectedValue(new Error('missing_scope'));

      const result = await handleUploadFile(presentClients(), {
        channel: 'C1',
        filePaths: ['report.pdf'],
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
      expect(result.error?.message).toContain('missing_scope');
    });
  });

  describe('handleUploadFile transfer errors', () => {
    it('keeps an UploadTransferError message verbatim', async () => {
      const message = 'Uploading report.pdf failed: fetch failed (ECONNRESET). No file was shared.';
      vi.mocked(client.uploadFile).mockRejectedValue(new UploadTransferError(message));

      const result = await handleUploadFile(presentClients(), {
        channel: 'C1',
        filePaths: ['report.pdf'],
      });

      expect(result.error).toEqual({ code: 'UPLOAD_FAILED', message });
      expect(client.formatSlackError).not.toHaveBeenCalled();
    });
  });

  describe('createFileTools', () => {
    it('registers getFileContent, downloadFile and uploadFile with required metadata', () => {
      const tools = createFileTools(presentClients());
      expect(tools.map((t) => t.tool.name)).toEqual([
        'getFileContent',
        'downloadFile',
        'uploadFile',
      ]);
      const read = tools[0].tool;
      expect(read.inputSchema.required).toEqual(['file']);
      expect(read.annotations?.readOnlyHint).toBe(true);
      expect(read._meta?.[META_KEYS.DEFER_LOADING]).toBe(true);
      const download = tools[1].tool;
      expect(download.inputSchema.required).toEqual(['file']);
      expect(download.annotations?.readOnlyHint).not.toBe(true);
      expect(download._meta?.[META_KEYS.DEFER_LOADING]).toBe(true);
      const upload = tools[2].tool;
      expect(upload.inputSchema.required).toEqual(['channel', 'filePaths']);
      expect(Object.keys(upload.inputSchema.properties as object)).toEqual([
        'channel',
        'filePaths',
        'thread_ts',
        'initial_comment',
      ]);
      expect(upload.inputSchema.properties).toMatchObject({
        filePaths: { type: 'array', minItems: 1, maxItems: MAX_UPLOAD_FILES },
      });
      expect(upload.annotations).toEqual(WRITE_ANNOTATIONS);
      expect(upload._meta?.[META_KEYS.DEFER_LOADING]).toBe(true);
      expect(upload._meta?.[META_KEYS.TIMEOUT_CLASS]).toBe('long');
      expect(upload.description).toContain('files:write');
      expect(upload.description).toContain('1 GB');
      expect(upload.description).toContain('10 minutes');
      expect(upload.outputSchema?.properties).toMatchObject({
        files: {
          items: {
            properties: { id: { type: 'string' }, name: { type: 'string' } },
            required: ['id', 'name'],
          },
        },
      });
      expect(Object.keys(upload.outputSchema?.properties as object).sort()).toEqual(
        ['channel', 'error', 'files', 'ok', 'success', 'thread_ts'].sort()
      );
    });

    it('rejects an upload call that omits a required parameter', async () => {
      const upload = createFileTools(presentClients())[2];
      const result = await upload.handler({ channel: 'C1' });
      expect(result.isError).toBe(true);
      expect(client.uploadFile).not.toHaveBeenCalled();
    });

    it('returns NOT_CONFIGURED for every tool when the worker has no token', async () => {
      const tools = createFileTools(unconfiguredClients());

      for (const { handler } of tools) {
        const result = await handler({
          file: 'F1',
          channel: 'C1',
          filePaths: ['a.txt'],
        });
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0].text as string);
        expect(parsed.code).toBe('NOT_CONFIGURED');
      }
    });
  });
});
