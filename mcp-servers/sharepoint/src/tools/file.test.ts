/**
 * File Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleListFileIds, handleGetFileFull, handleSync } from './file-tools.js';
import type { SharePointClient } from '../client.js';
import * as fs from 'fs/promises';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

type MockClient = {
  listFiles: Mock;
  getFileMetadata: Mock;
  syncFile: Mock;
  formatError: Mock;
};

describe('file-tools', () => {
  const createMockClient = (): MockClient => ({
    listFiles: vi.fn(),
    getFileMetadata: vi.fn(),
    syncFile: vi.fn(),
    formatError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleListFileIds', () => {
    it('returns files successfully with default path', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({
        files: [
          { id: '1', name: 'test.txt', isFolder: false, path: 'test.txt' },
          { id: '2', name: 'folder', isFolder: true, path: 'folder' },
        ],
        exists: true,
      });

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        files: [
          { id: '1', name: 'test.txt', isFolder: false },
          { id: '2', name: 'folder', isFolder: true },
        ],
        count: 2,
        exists: true,
      });
      expect(client.listFiles).toHaveBeenCalledWith({});
    });

    it('returns files successfully with specified path', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({
        files: [{ id: '3', name: 'doc.pdf', isFolder: false, path: 'docs/doc.pdf' }],
        exists: true,
      });

      const result = await handleListFileIds(client as unknown as SharePointClient, {
        path: 'docs',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        files: [{ id: '3', name: 'doc.pdf', isFolder: false }],
        count: 1,
        exists: true,
      });
      expect(client.listFiles).toHaveBeenCalledWith({ path: 'docs' });
    });

    it('returns empty array when no files exist', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({ files: [], exists: true });

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        files: [],
        count: 0,
        exists: true,
      });
    });

    it('returns exists: false when folder does not exist (404)', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({ files: [], exists: false });

      const result = await handleListFileIds(client as unknown as SharePointClient, {
        path: 'nonexistent-folder',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        files: [],
        count: 0,
        exists: false,
      });
    });

    it('handles undefined files array gracefully', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({ files: undefined as any });

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        files: [],
        count: 0,
      });
    });

    it('returns error when API call fails', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('Network error'));

      const result = await handleListFileIds(client as unknown as SharePointClient, { path: '/' });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LIST_FAILED',
        message: 'Network error',
      });
    });

    it('returns error for 401 unauthorized', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('returns error for 403 forbidden', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('403 Forbidden'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('returns error for 404 not found', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('404 not found'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });
  });

  describe('handleGetFileFull', () => {
    it('returns file metadata successfully', async () => {
      const client = createMockClient();
      const metadata = {
        id: '123',
        name: 'test.txt',
        size: 1024,
        lastModifiedDateTime: '2025-01-01T00:00:00Z',
        webUrl: 'https://sharepoint.com/test.txt',
        eTag: 'abc123',
        file: { mimeType: 'text/plain' },
      };
      client.getFileMetadata.mockResolvedValue(metadata);

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(metadata);
      expect(client.getFileMetadata).toHaveBeenCalledWith('123');
    });

    it('returns folder metadata successfully', async () => {
      const client = createMockClient();
      const metadata = {
        id: '456',
        name: 'folder',
        folder: { childCount: 5 },
      };
      client.getFileMetadata.mockResolvedValue(metadata);

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '456',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(metadata);
    });

    it('returns error when file not found', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('Resource not found in SharePoint.'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'GET_FAILED',
        message: 'Resource not found in SharePoint.',
      });
    });

    it('returns error when API call fails', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('API error'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'GET_FAILED',
        message: 'API error',
      });
    });

    it('handles network timeout', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('Request timeout'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GET_FAILED');
    });
  });

  describe('handleSync', () => {
    it('syncs file successfully with basic params', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        etag: 'new-etag-123',
        size: 2048,
      };
      client.syncFile.mockResolvedValue(syncResult);

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
      expect(client.syncFile).toHaveBeenCalledWith({
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
      });
    });

    it('syncs file with expectedEtag for Compare-And-Swap', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        etag: 'new-etag-456',
        size: 1024,
      };
      client.syncFile.mockResolvedValue(syncResult);

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
        expectedEtag: 'old-etag-123',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
      expect(client.syncFile).toHaveBeenCalledWith({
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
        expectedEtag: 'old-etag-123',
      });
    });

    it('syncs file with createOnly flag', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        etag: 'new-etag-789',
        size: 512,
      };
      client.syncFile.mockResolvedValue(syncResult);

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/new.txt',
        sharepointPath: 'docs/new.txt',
        createOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
      expect(client.syncFile).toHaveBeenCalledWith({
        localPath: '/tmp/new.txt',
        sharepointPath: 'docs/new.txt',
        createOnly: true,
      });
    });

    it('syncs file with overwrite flag', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        etag: 'overwrite-etag',
        size: 4096,
      };
      client.syncFile.mockResolvedValue(syncResult);

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/overwrite.txt',
        sharepointPath: 'docs/overwrite.txt',
        overwrite: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
    });

    it('syncs file with all options', async () => {
      const client = createMockClient();
      const syncResult = {
        success: true,
        etag: 'full-options-etag',
        size: 8192,
      };
      client.syncFile.mockResolvedValue(syncResult);

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/full.txt',
        sharepointPath: 'docs/full.txt',
        expectedEtag: 'expected',
        createOnly: false,
        overwrite: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(syncResult);
    });

    it('returns error when sync fails', async () => {
      const client = createMockClient();
      client.syncFile.mockRejectedValue(new Error('Upload failed'));

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/fail.txt',
        sharepointPath: 'docs/fail.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'SYNC_FAILED',
        message: 'Upload failed',
      });
    });

    it('returns error for invalid path (path traversal)', async () => {
      const client = createMockClient();
      client.syncFile.mockRejectedValue(new Error('Invalid path (security check failed)'));

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
        sharepointPath: '../../../etc/passwd',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_FAILED');
    });

    it('returns error when ETag mismatch (CAS failure)', async () => {
      const client = createMockClient();
      client.syncFile.mockRejectedValue(
        new Error('ETag mismatch - file was modified by another process')
      );

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
        expectedEtag: 'wrong-etag',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_FAILED');
    });

    it('returns error when createOnly fails (file already exists)', async () => {
      const client = createMockClient();
      client.syncFile.mockRejectedValue(new Error('File already exists'));

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
        sharepointPath: 'docs/test.txt',
        createOnly: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_FAILED');
    });

    it('returns error when local file does not exist', async () => {
      const client = createMockClient();
      client.syncFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/nonexistent.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_FAILED');
    });

    it('returns error when mode is used with file path instead of directory', async () => {
      const client = createMockClient();

      // Mock fs.stat to return file stats
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
      } as any);

      const result = await handleSync(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO/state.json',
        mode: 'push',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PARAM');
      expect(result.error?.message).toContain("Cannot use 'mode' parameter with a file path");
      expect(result.error?.message).toContain('state.json');
    });

    it('allows mode with directory path', async () => {
      const client = createMockClient();

      // Mock fs.stat to return directory stats
      vi.mocked(fs.stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      } as any);

      // Note: This will fail because handleSyncDirectory is not mocked,
      // but we're testing that the file check passes
      const result = await handleSync(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/MASŁO',
        mode: 'push',
      });

      // Should not return INVALID_PARAM error (file check passed)
      expect(result.error?.code).not.toBe('INVALID_PARAM');
    });

    it('allows mode when path does not exist (let syncDirectory handle it)', async () => {
      const client = createMockClient();

      // Mock fs.stat to throw ENOENT
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

      // Note: This will fail because handleSyncDirectory is not mocked,
      // but we're testing that the file check is skipped
      const result = await handleSync(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/NewClient',
        mode: 'pull',
      });

      // Should not return INVALID_PARAM error (stat failed, so we skip check)
      expect(result.error?.code).not.toBe('INVALID_PARAM');
    });

    it('translates Claude container path before fs.stat check', async () => {
      const client = createMockClient();

      // Mock fs.stat to capture the path and return file stats
      const statMock = vi.mocked(fs.stat);
      statMock.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
      } as any);

      await handleSync(client as unknown as SharePointClient, {
        local_path: '/home/speedwave/.claude/context/opportunities/TestClient/state.json',
        mode: 'push',
      });

      // fs.stat should be called with translated path (/context/...) not Claude path
      expect(statMock).toHaveBeenCalledWith('/context/opportunities/TestClient/state.json');
    });

    it('returns MISSING_PARAM when localPath is missing (no mode)', async () => {
      const client = createMockClient();

      const result = await handleSync(client as unknown as SharePointClient, {
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('localPath');
    });

    it('returns MISSING_PARAM when sharepointPath is missing (no mode)', async () => {
      const client = createMockClient();

      const result = await handleSync(client as unknown as SharePointClient, {
        localPath: '/tmp/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('sharepointPath');
    });
  });
});
