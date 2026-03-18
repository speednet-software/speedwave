/**
 * File Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  handleListFileIds,
  handleGetFileFull,
  handleDownloadFile,
  handleUploadFile,
} from './file-tools.js';
import type { SharePointClient } from '../client.js';

type MockClient = {
  listFiles: Mock;
  getFileMetadata: Mock;
  uploadFile: Mock;
  downloadFile: Mock;
  formatError: Mock;
};

describe('file-tools', () => {
  const createMockClient = (): MockClient => ({
    listFiles: vi.fn(),
    getFileMetadata: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
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

  describe('handleDownloadFile', () => {
    it('downloads file successfully', async () => {
      const client = createMockClient();
      client.downloadFile.mockResolvedValue(undefined);

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/report.pdf',
        localPath: '/workspace/report.pdf',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ downloaded: '/workspace/report.pdf' });
      expect(client.downloadFile).toHaveBeenCalledWith('docs/report.pdf', '/workspace/report.pdf');
    });

    it('accepts snake_case parameters', async () => {
      const client = createMockClient();
      client.downloadFile.mockResolvedValue(undefined);

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepoint_path: 'docs/file.txt',
        local_path: '/workspace/file.txt',
      });

      expect(result.success).toBe(true);
      expect(client.downloadFile).toHaveBeenCalledWith('docs/file.txt', '/workspace/file.txt');
    });

    it('returns MISSING_PARAM when sharepointPath is missing', async () => {
      const client = createMockClient();

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('sharepointPath');
    });

    it('returns MISSING_PARAM when localPath is missing', async () => {
      const client = createMockClient();

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('localPath');
    });

    it('returns error when download fails', async () => {
      const client = createMockClient();
      client.downloadFile.mockRejectedValue(new Error('Download failed'));

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/file.txt',
        localPath: '/workspace/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'DOWNLOAD_FAILED',
        message: 'Download failed',
      });
    });

    it('returns error for path traversal', async () => {
      const client = createMockClient();
      client.downloadFile.mockRejectedValue(
        new Error('Invalid path (security check failed - traversal)')
      );

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: '../../../etc/passwd',
        localPath: '/workspace/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DOWNLOAD_FAILED');
    });
  });

  describe('handleUploadFile', () => {
    it('uploads file successfully with basic params', async () => {
      const client = createMockClient();
      const uploadResult = { etag: 'new-etag-123', size: 2048 };
      client.uploadFile.mockResolvedValue(uploadResult);

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(uploadResult);
      expect(client.uploadFile).toHaveBeenCalledWith('docs/test.txt', '/workspace/test.txt', {});
    });

    it('uploads file with expectedEtag for Compare-And-Swap', async () => {
      const client = createMockClient();
      const uploadResult = { etag: 'new-etag-456', size: 1024 };
      client.uploadFile.mockResolvedValue(uploadResult);

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
        expectedEtag: 'old-etag-123',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(uploadResult);
      expect(client.uploadFile).toHaveBeenCalledWith('docs/test.txt', '/workspace/test.txt', {
        expectedEtag: 'old-etag-123',
      });
    });

    it('uploads file with createOnly flag', async () => {
      const client = createMockClient();
      const uploadResult = { etag: 'new-etag-789', size: 512 };
      client.uploadFile.mockResolvedValue(uploadResult);

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/new.txt',
        sharepointPath: 'docs/new.txt',
        createOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(uploadResult);
      expect(client.uploadFile).toHaveBeenCalledWith('docs/new.txt', '/workspace/new.txt', {
        createOnly: true,
      });
    });

    it('uploads file with overwrite flag', async () => {
      const client = createMockClient();
      const uploadResult = { etag: 'overwrite-etag', size: 4096 };
      client.uploadFile.mockResolvedValue(uploadResult);

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/overwrite.txt',
        sharepointPath: 'docs/overwrite.txt',
        overwrite: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(uploadResult);
      expect(client.uploadFile).toHaveBeenCalledWith(
        'docs/overwrite.txt',
        '/workspace/overwrite.txt',
        { overwrite: true }
      );
    });

    it('accepts snake_case parameters', async () => {
      const client = createMockClient();
      client.uploadFile.mockResolvedValue({ etag: 'test', size: 100 });

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        local_path: '/workspace/test.txt',
        sharepoint_path: 'docs/test.txt',
        expected_etag: 'etag-abc',
        create_only: true,
      });

      expect(result.success).toBe(true);
      expect(client.uploadFile).toHaveBeenCalledWith('docs/test.txt', '/workspace/test.txt', {
        expectedEtag: 'etag-abc',
        createOnly: true,
      });
    });

    it('returns MISSING_PARAM when localPath is missing', async () => {
      const client = createMockClient();

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('localPath');
    });

    it('returns MISSING_PARAM when sharepointPath is missing', async () => {
      const client = createMockClient();

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('sharepointPath');
    });

    it('returns error when upload fails', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('Upload failed'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/fail.txt',
        sharepointPath: 'docs/fail.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'UPLOAD_FAILED',
        message: 'Upload failed',
      });
    });

    it('returns error when ETag mismatch (CAS failure)', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(
        new Error('ETag mismatch - file was modified by another process')
      );

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
        expectedEtag: 'wrong-etag',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('returns error when createOnly fails (file already exists)', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('File already exists'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
        createOnly: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('returns error when local file does not exist', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/nonexistent.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });
  });
});
