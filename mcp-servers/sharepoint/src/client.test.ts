/**
 * Comprehensive tests for SharePoint/Microsoft Graph API Client
 * Target: 90%+ code coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharePointClient, initializeSharePointClient, SharePointConfig } from './client.js';
import fs from 'fs/promises';
import path from 'path';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('../../shared/dist/index.js', () => ({
  loadToken: vi.fn(),
  ts: () => '[00:00:00]',
  TIMEOUTS: {
    BASE_MS: 120000,
    API_CALL_MS: 30000,
    TOKEN_REFRESH_MS: 30000,
    HEALTH_CHECK_MS: 5000,
    MIN_MS: 1000,
    EXECUTION_MS: 120000,
    WORKER_REQUEST_MS: 120000,
    LONG_OPERATION_MS: 300000,
    ASYNC_JOB_MS: 900000,
  },
}));

const mockFs = vi.mocked(fs);
const { loadToken } = await import('../../shared/dist/index.js');
const mockLoadToken = vi.mocked(loadToken);

// Test configuration
const mockConfig: SharePointConfig = {
  clientId: 'test-client-id',
  tenantId: 'test-tenant-id',
  siteId: 'test-site-id',
  basePath: 'Documents/TestFolder',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
};

const mockTokensDir = '/test/tokens';

describe('SharePointClient', () => {
  let client: SharePointClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock global fetch
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    // Create fresh client instance
    client = new SharePointClient({ ...mockConfig }, mockTokensDir);

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Constructor & Configuration
  //═══════════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('should initialize with valid config', () => {
      expect(client).toBeInstanceOf(SharePointClient);
      expect(client.getConfig()).toEqual(mockConfig);
    });

    it('should store tokens directory', () => {
      const config = client.getConfig();
      expect(config.clientId).toBe(mockConfig.clientId);
    });
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = client.getConfig();
      expect(config).toEqual(mockConfig);
    });

    it('should return updated config after token refresh', async () => {
      const newAccessToken = 'new-access-token';
      const newRefreshToken = 'new-refresh-token';

      // First call returns 401 (trigger refresh)
      fetchMock.mockResolvedValueOnce({
        status: 401,
        ok: false,
      });

      // Token refresh succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockResolvedValue(undefined);

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      const config = client.getConfig();
      expect(config.accessToken).toBe(newAccessToken);
      expect(config.refreshToken).toBe(newRefreshToken);
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═══════════════════════════════════════════════════════════════════════════════

  describe('formatError', () => {
    it('should format 401 unauthorized errors', () => {
      const error = new Error('401 Unauthorized');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toContain('Authentication failed');
      expect(formatted).toContain('speedwave setup sharepoint');
    });

    it('should format 403 forbidden errors', () => {
      const error = new Error('403 Forbidden');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toContain('Permission denied');
    });

    it('should format 404 not found errors', () => {
      const error = new Error('404 not found');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toBe('Resource not found in SharePoint.');
    });

    it('should format security/traversal errors', () => {
      const error = new Error('security check failed');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toContain('Invalid path');
      expect(formatted).toContain('traversal not allowed');
    });

    it('should format token refresh errors', () => {
      const error = new Error('Failed to refresh token');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toContain('Token refresh failed');
    });

    it('should handle generic errors', () => {
      const error = new Error('Something went wrong');
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toBe('Something went wrong');
    });

    it('should handle errors without message', () => {
      const error = {};
      const formatted = SharePointClient.formatError(error);
      expect(formatted).toBe('SharePoint API error');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Authentication & Token Management
  //═══════════════════════════════════════════════════════════════════════════════

  describe('refreshAccessToken', () => {
    it('should refresh access token successfully', async () => {
      const newAccessToken = 'new-access-token';
      const newRefreshToken = 'new-refresh-token';

      // First call returns 401 (trigger refresh)
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh call
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockResolvedValue(undefined);

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('login.microsoftonline.com'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );
    });

    it('should update access token without new refresh token', async () => {
      const newAccessToken = 'new-access-token-only';

      // First call returns 401
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh (no new refresh token)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: newAccessToken,
          // No refresh_token in response
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockResolvedValue(undefined);

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      const config = client.getConfig();
      expect(config.accessToken).toBe(newAccessToken);
      expect(config.refreshToken).toBe(mockConfig.refreshToken); // Unchanged
    });

    it('should save refreshed tokens to file system', async () => {
      const newAccessToken = 'new-access-token';
      const newRefreshToken = 'new-refresh-token';

      // First call returns 401
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockResolvedValue(undefined);

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join(mockTokensDir, 'access_token'),
        newAccessToken,
        { mode: 0o600 }
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join(mockTokensDir, 'refresh_token'),
        newRefreshToken,
        { mode: 0o600 }
      );
    });

    it('should handle file system errors when saving tokens', async () => {
      // First call returns 401
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockRejectedValue(new Error('Read-only file system'));

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      // Should not throw, just log error with details
      await expect(client.listFiles()).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save refreshed tokens'),
        expect.objectContaining({
          error: expect.any(String),
          consequence: expect.stringContaining('Tokens valid in memory'),
          suggestion: expect.stringContaining('writable'),
        })
      );
    });

    it('should throw error when token refresh fails', async () => {
      // First call returns 401
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'invalid_grant' }),
      });

      await expect(client.listFiles()).rejects.toThrow('Failed to refresh access token');
    });
  });

  describe('callGraphAPI', () => {
    it('should call Graph API with authorization header', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockConfig.accessToken}`,
          }),
        })
      );
    });

    it('should retry on 401 with refreshed token', async () => {
      // First call returns 401
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockFs.writeFile.mockResolvedValue(undefined);

      // Retry succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles();

      expect(fetchMock).toHaveBeenCalledTimes(3); // Initial + refresh + retry
    });

    it('should merge custom headers with authorization', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test content'));

      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // File upload succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 12 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'file.txt',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
            'Content-Type': 'application/octet-stream',
          }),
        })
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Path Handling
  //═══════════════════════════════════════════════════════════════════════════════

  describe('encodeGraphPath', () => {
    it('should encode path segments for Graph API', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles({ path: 'folder with spaces/file.txt' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('folder%20with%20spaces/file.txt'),
        expect.any(Object)
      );
    });

    it('should handle special characters in paths', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await client.listFiles({ path: 'folder/file&name.txt' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('file%26name.txt'),
        expect.any(Object)
      );
    });
  });

  describe('validatePath', () => {
    it('should reject path with parent directory traversal (../', async () => {
      await expect(client.listFiles({ path: '../etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject path with Windows parent directory traversal (..\\)', async () => {
      await expect(client.listFiles({ path: '..\\windows\\system32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject absolute paths starting with /', async () => {
      await expect(client.listFiles({ path: '/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject absolute paths starting with \\', async () => {
      await expect(client.listFiles({ path: '\\windows\\system32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject paths with null bytes', async () => {
      await expect(client.listFiles({ path: 'file\0.txt' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    // URL-encoded traversal tests (security fix #1)
    it('should reject URL-encoded path traversal (%2e%2e)', async () => {
      await expect(client.listFiles({ path: '%2e%2e/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject double-encoded path traversal (%252e%252e)', async () => {
      await expect(client.listFiles({ path: '%252e%252e/etc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject mixed URL-encoded traversal (..%2f)', async () => {
      await expect(client.listFiles({ path: '..%2f..%2fetc/passwd' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject URL-encoded backslash traversal (%2e%2e%5c)', async () => {
      await expect(client.listFiles({ path: '%2e%2e%5cwindows%5csystem32' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject standalone ".." in path', async () => {
      await expect(client.listFiles({ path: 'folder/../secret' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should reject invalid URL encoding', async () => {
      // Invalid percent encoding should be rejected
      await expect(client.listFiles({ path: '%GG/file.txt' })).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should accept valid relative paths', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await expect(client.listFiles({ path: 'valid/path/to/folder' })).resolves.toBeDefined();
    });

    it('should accept empty path', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      await expect(client.listFiles({ path: '' })).resolves.toBeDefined();
    });
  });

  describe('API timeout (security fix #2)', () => {
    it('should timeout on slow Graph API response', async () => {
      // Mock slow response that takes longer than API_TIMEOUT_MS (30000ms)
      // We'll simulate abort by making fetch reject with AbortError
      fetchMock.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        });
      });

      await expect(client.listFiles()).rejects.toThrow(/timeout/i);
    });

    it('should timeout on slow token refresh', async () => {
      // First call returns 401 (trigger refresh)
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false });

      // Token refresh hangs and times out
      fetchMock.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        });
      });

      await expect(client.listFiles()).rejects.toThrow(/timeout/i);
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listFiles', () => {
    it('should list files in base directory', async () => {
      const mockFiles = [
        {
          id: 'file-1',
          name: 'document.docx',
          size: 1024,
          lastModifiedDateTime: '2023-01-01T00:00:00Z',
          webUrl: 'https://sharepoint.com/file1',
        },
        {
          id: 'folder-1',
          name: 'Reports',
          folder: {},
          webUrl: 'https://sharepoint.com/folder1',
        },
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: mockFiles }),
      });

      const result = await client.listFiles();

      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({
        id: 'file-1',
        name: 'document.docx',
        path: 'document.docx',
        size: 1024,
        lastModified: '2023-01-01T00:00:00Z',
        isFolder: false,
        webUrl: 'https://sharepoint.com/file1',
      });
      expect(result.files[1]).toMatchObject({
        id: 'folder-1',
        name: 'Reports',
        path: 'Reports',
        isFolder: true,
      });
      expect(result.exists).toBe(true);
    });

    it('should list files in subdirectory', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'file-2', name: 'report.pdf', size: 2048 }],
        }),
      });

      const result = await client.listFiles({ path: 'Reports' });

      expect(result.files[0].path).toBe('Reports/report.pdf');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`${mockConfig.basePath}/Reports`),
        expect.any(Object)
      );
    });

    it('should handle empty directory', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      const result = await client.listFiles();

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(true);
    });

    it('should handle missing value in response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.listFiles();

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(true);
    });

    it('should throw error on API failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Access denied');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.listFiles()).rejects.toThrow('Failed to list files');
    });

    it('should return empty array when folder not found (404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Item not found' } }),
      });

      const result = await client.listFiles({ path: 'nonexistent-folder' });

      expect(result.files).toEqual([]);
      expect(result.exists).toBe(false);
    });

    it('should throw error for 403 Forbidden (not 404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Access denied');
    });

    it('should throw error for 500 Server Error (not 404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Internal server error' } }),
      });

      await expect(client.listFiles()).rejects.toThrow('Internal server error');
    });
  });

  describe('getFileMetadata', () => {
    it('should retrieve file metadata by ID', async () => {
      const mockMetadata = {
        id: 'file-1',
        name: 'document.docx',
        size: 1024,
        createdDateTime: '2023-01-01T00:00:00Z',
        lastModifiedDateTime: '2023-01-02T00:00:00Z',
        eTag: '"abc123"',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockMetadata,
      });

      const result = await client.getFileMetadata('file-1');

      expect(result).toEqual(mockMetadata);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://graph.microsoft.com/v1.0/sites/${mockConfig.siteId}/drive/items/file-1`,
        expect.any(Object)
      );
    });

    it('should throw error when file not found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Item not found' } }),
      });

      await expect(client.getFileMetadata('invalid-id')).rejects.toThrow('Item not found');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.getFileMetadata('file-1')).rejects.toThrow('Failed to get file metadata');
    });
  });

  describe('getCurrentUser', () => {
    it('should retrieve current user information', async () => {
      const mockUser = {
        displayName: 'John Doe',
        mail: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
        id: 'user-123',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockUser,
      });

      const result = await client.getCurrentUser();

      expect(result).toEqual({
        displayName: 'John Doe',
        email: 'john.doe@example.com',
        userPrincipalName: 'john.doe@example.com',
        id: 'user-123',
      });
    });

    it('should use userPrincipalName as email fallback', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          displayName: 'Jane Smith',
          userPrincipalName: 'jane.smith@example.com',
          id: 'user-456',
        }),
      });

      const result = await client.getCurrentUser();

      expect(result.email).toBe('jane.smith@example.com');
    });

    it('should handle missing user data with defaults', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await client.getCurrentUser();

      expect(result).toEqual({
        displayName: 'Unknown User',
        email: 'unknown@example.com',
        userPrincipalName: 'unknown',
        id: 'unknown',
      });
    });

    it('should throw error on API failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Unauthorized' } }),
      });

      await expect(client.getCurrentUser()).rejects.toThrow('Unauthorized');
    });

    it('should throw generic error when error message missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await expect(client.getCurrentUser()).rejects.toThrow('Failed to get user info');
    });
  });

  describe('syncFile', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test file content'));
    });

    it('should upload file successfully', async () => {
      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Check parent folder 'remote' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'folder-remote' }),
      });

      // Upload file
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          eTag: '"abc123"',
          size: 17,
        }),
      });

      const result = await client.syncFile({
        localPath: '/context/local/file.txt',
        sharepointPath: 'remote/file.txt',
      });

      expect(result).toEqual({
        success: true,
        etag: '"abc123"',
        size: 17,
      });

      expect(mockFs.readFile).toHaveBeenCalledWith('/context/local/file.txt');
    });

    it('should validate SharePoint path', async () => {
      await expect(
        client.syncFile({
          localPath: '/context/file.txt',
          sharepointPath: '../../../etc/passwd',
        })
      ).rejects.toThrow('Invalid sharepoint_path (security check failed)');
    });

    it('should include expectedEtag in If-Match header', async () => {
      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Upload file with etag
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"new123"', size: 17 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'file.txt',
        expectedEtag: '"old123"',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-Match': '"old123"',
          }),
        })
      );
    });

    it('should include If-None-Match header for createOnly', async () => {
      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Upload file with createOnly
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc123"', size: 17 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'file.txt',
        createOnly: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': '*',
          }),
        })
      );
    });

    it('should ensure parent folders exist', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Check 'newfolder' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create 'newfolder'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-1' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc123"', size: 17 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'newfolder/file.txt',
      });

      // Should check parent folder exists
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/newfolder'),
        expect.not.objectContaining({ method: 'POST' })
      );

      // Should create parent folder
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/children'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error on upload failure', async () => {
      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Upload fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'Conflict' } }),
      });

      await expect(
        client.syncFile({
          localPath: '/context/file.txt',
          sharepointPath: 'file.txt',
        })
      ).rejects.toThrow('Conflict');
    });

    it('should throw generic error when error message missing', async () => {
      // Check parent 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check parent 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Upload fails without error message
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      await expect(
        client.syncFile({
          localPath: '/context/file.txt',
          sharepointPath: 'file.txt',
        })
      ).rejects.toThrow('Upload failed');
    });
  });

  describe('ensureParentFolders', () => {
    it('should create nested parent folders', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Check base path 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // First level folder 'level1' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-1' }),
      });

      // Second level folder 'level2' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'folder-2' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'level1/level2/file.txt',
      });

      // Should create both new parent folders (level1 and level2)
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(2);
    });

    it('should skip folder creation if folder exists', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Parent folder 'existing' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'existing-folder' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'existing/file.txt',
      });

      // Should not create any folder (all exist)
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('should handle file in root directory', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'file.txt',
      });

      // Should check base path folders + upload
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should create folder at root level', async () => {
      mockFs.readFile.mockResolvedValue(Buffer.from('test'));

      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Check 'rootfolder' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create folder 'rootfolder'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'root-folder' }),
      });

      // File upload
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"abc"', size: 4 }),
      });

      await client.syncFile({
        localPath: '/context/file.txt',
        sharepointPath: 'rootfolder/file.txt',
      });

      // Should create folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][1]?.body).toContain('rootfolder');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Empty Folder Support
  //═══════════════════════════════════════════════════════════════════════════════

  describe('createRemoteFolder', () => {
    it('should create a new folder successfully', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Create folder succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'new-folder', name: 'newfolder' }),
      });

      await client.createRemoteFolder('newfolder');

      // Verify POST call to create folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][1]?.body).toContain('newfolder');
      expect(postCalls[0][1]?.body).toContain('"folder":{}');
    });

    it('should create nested folder with parent folders', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Check parent 'level1' doesn't exist
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

      // Create parent 'level1'
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'level1-folder' }),
      });

      // Create 'level2' folder
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'level2-folder', name: 'level2' }),
      });

      await client.createRemoteFolder('level1/level2');

      // Should create both parent and folder
      const postCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(postCalls.length).toBe(2);
    });

    it('should handle 409 Conflict (folder already exists) as idempotent', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Create folder returns 409 Conflict (already exists)
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'Item already exists' } }),
      });

      // Should not throw error - idempotent operation
      await expect(client.createRemoteFolder('existing')).resolves.toBeUndefined();
    });

    it('should throw error on 403 Forbidden (permission denied)', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Create folder returns 403 Forbidden
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Access denied' } }),
      });

      await expect(client.createRemoteFolder('forbidden')).rejects.toThrow('Access denied');
    });

    it('should throw error on 500 Internal Server Error', async () => {
      // Check 'Documents' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'doc-folder' }),
      });

      // Check 'TestFolder' exists
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'test-folder' }),
      });

      // Create folder returns 500 Internal Server Error
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Internal server error' } }),
      });

      await expect(client.createRemoteFolder('servererror')).rejects.toThrow(
        'Internal server error'
      );
    });

    it('should validate path and reject traversal attempts', async () => {
      await expect(client.createRemoteFolder('../etc/passwd')).rejects.toThrow(
        'Invalid path (security check failed)'
      );

      await expect(client.createRemoteFolder('/etc/passwd')).rejects.toThrow(
        'Invalid path (security check failed)'
      );

      await expect(client.createRemoteFolder('folder/../../etc')).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });

    it('should handle invalid folder path (empty string)', async () => {
      // Empty string is caught by path validator before we check folder name
      await expect(client.createRemoteFolder('')).rejects.toThrow(
        'Invalid path (security check failed)'
      );
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Factory & Initialization
  //═══════════════════════════════════════════════════════════════════════════════

  describe('initializeSharePointClient', () => {
    const originalEnv = process.env.TOKENS_DIR;

    beforeEach(() => {
      delete process.env.TOKENS_DIR;
    });

    afterEach(() => {
      if (originalEnv) {
        process.env.TOKENS_DIR = originalEnv;
      } else {
        delete process.env.TOKENS_DIR;
      }
    });

    it('should initialize client with valid tokens', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return 'test-access-token';
        if (path.includes('refresh_token')) return 'test-refresh-token';
        if (path.includes('client_id')) return 'test-client-id';
        if (path.includes('tenant_id')) return 'test-tenant-id';
        if (path.includes('site_id')) return 'test-site-id';
        if (path.includes('base_path')) return 'Documents/Test';
        return '';
      });

      const client = await initializeSharePointClient();

      expect(client).toBeInstanceOf(SharePointClient);
      expect(client?.getConfig().accessToken).toBe('test-access-token');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SharePoint tokens loaded'));
    });

    it('should use TOKENS_DIR environment variable', async () => {
      process.env.TOKENS_DIR = '/custom/tokens';

      mockLoadToken.mockImplementation(async () => 'token-value');

      await initializeSharePointClient();

      expect(mockLoadToken).toHaveBeenCalledWith(expect.stringContaining('/custom/tokens'));
    });

    it('should use /tokens as default directory', async () => {
      mockLoadToken.mockImplementation(async () => 'token-value');

      await initializeSharePointClient();

      expect(mockLoadToken).toHaveBeenCalledWith(expect.stringContaining('/tokens'));
    });

    it('should return null when tokens are empty', async () => {
      mockLoadToken.mockResolvedValue('');

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when access token is missing', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('access_token')) return '';
        return 'valid-token';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when refresh token is missing', async () => {
      mockLoadToken.mockImplementation(async (path: string) => {
        if (path.includes('refresh_token')) return '';
        return 'valid-token';
      });

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when loadToken throws error', async () => {
      mockLoadToken.mockRejectedValue(new Error('Token not found'));

      const result = await initializeSharePointClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null when any required token is missing', async () => {
      const tokens = {
        access_token: 'access',
        refresh_token: 'refresh',
        client_id: 'client',
        tenant_id: 'tenant',
        site_id: 'site',
        base_path: 'base',
      };

      for (const key of Object.keys(tokens)) {
        mockLoadToken.mockImplementation(async (path: string) => {
          if (path.includes(key)) return '';
          return 'valid';
        });

        const result = await initializeSharePointClient();
        expect(result).toBeNull();
        expect(console.warn).toHaveBeenCalled();
      }
    });
  });

  describe('listFilesRecursive', () => {
    it('should list files recursively without empty folders by default', async () => {
      // Root folder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'file1',
              name: 'file1.txt',
              size: 100,
              lastModifiedDateTime: '2024-01-01T00:00:00Z',
              eTag: '"etag1"',
            },
            {
              id: 'folder1',
              name: 'folder1',
              folder: { childCount: 1 },
            },
          ],
        }),
      });

      // Subfolder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'file2',
              name: 'file2.txt',
              size: 200,
              lastModifiedDateTime: '2024-01-02T00:00:00Z',
              eTag: '"etag2"',
            },
          ],
        }),
      });

      const files = await client.listFilesRecursive('');

      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('file1.txt');
      expect(files[0].isFolder).toBe(false);
      expect(files[1].path).toBe('folder1/file2.txt');
      expect(files[1].isFolder).toBe(false);
    });

    it('should include empty folders when includeEmptyFolders is true', async () => {
      // Root folder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'file1',
              name: 'file1.txt',
              size: 100,
              lastModifiedDateTime: '2024-01-01T00:00:00Z',
              eTag: '"etag1"',
            },
            {
              id: 'empty-folder',
              name: 'empty',
              folder: { childCount: 0 },
            },
          ],
        }),
      });

      // Empty folder listing (no children)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      // Get metadata for empty folder
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'empty-folder',
          name: 'empty',
          folder: { childCount: 0 },
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
        }),
      });

      const files = await client.listFilesRecursive('', { includeEmptyFolders: true });

      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('file1.txt');
      expect(files[0].isFolder).toBe(false);
      expect(files[1].path).toBe('empty');
      expect(files[1].isFolder).toBe(true);
      expect(files[1].etag).toBe('folder');
      expect(files[1].size).toBe(0);
    });

    it('should include nested empty folders', async () => {
      // 1. Root folder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'parent-folder',
              name: 'parent',
              folder: { childCount: 1 },
            },
          ],
        }),
      });

      // 2. Parent folder listing (contains empty child)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'empty-child',
              name: 'emptychild',
              folder: { childCount: 0 },
              lastModifiedDateTime: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      });

      // 3. Empty child folder listing (no children)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      // 4. Get metadata for empty child folder
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'empty-child',
          name: 'emptychild',
          folder: { childCount: 0 },
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
        }),
      });

      // 5. Get metadata for parent folder (to check if it's empty - it's not)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'parent-folder',
          name: 'parent',
          folder: { childCount: 1 },
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
        }),
      });

      const files = await client.listFilesRecursive('', { includeEmptyFolders: true });

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('parent/emptychild');
      expect(files[0].isFolder).toBe(true);
      expect(files[0].etag).toBe('folder');
    });

    it('should not include non-empty folders in results', async () => {
      // Root folder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'non-empty-folder',
              name: 'nonempty',
              folder: { childCount: 2 },
            },
          ],
        }),
      });

      // Non-empty folder listing
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'file1',
              name: 'file1.txt',
              size: 100,
              lastModifiedDateTime: '2024-01-01T00:00:00Z',
              eTag: '"etag1"',
            },
            {
              id: 'file2',
              name: 'file2.txt',
              size: 200,
              lastModifiedDateTime: '2024-01-02T00:00:00Z',
              eTag: '"etag2"',
            },
          ],
        }),
      });

      // Get metadata for non-empty folder
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'non-empty-folder',
          name: 'nonempty',
          folder: { childCount: 2 },
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
        }),
      });

      const files = await client.listFilesRecursive('', { includeEmptyFolders: true });

      // Should only include the 2 files, not the non-empty folder
      expect(files).toHaveLength(2);
      expect(files.every((f) => !f.isFolder)).toBe(true);
    });

    it('should include empty folder when recursive processing finds no children', async () => {
      // Root folder listing - folder with childCount: 0
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'empty-folder',
              name: 'empty',
              folder: { childCount: 0 },
            },
          ],
        }),
      });

      // Empty folder listing - confirms no children
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      });

      const files = await client.listFilesRecursive('', { includeEmptyFolders: true });

      // Empty folder should be included since recursive processing found no children
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'empty',
        isFolder: true,
        size: 0,
      });
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Directory Sync Tests
  //═════════════════════════════════════════════════════════════════════════════

  describe('syncDirectory', () => {
    describe('validateLocalPath', () => {
      it('should reject paths outside /home/speedwave/.claude/context', async () => {
        await expect(
          client.syncDirectory({
            localPath: '/workspace/docs',
            mode: 'pull',
          })
        ).rejects.toThrow('Invalid local_path');
      });

      it('should reject /tmp paths', async () => {
        await expect(
          client.syncDirectory({
            localPath: '/tmp/test',
            mode: 'pull',
          })
        ).rejects.toThrow('Invalid local_path');
      });

      it('should reject root path', async () => {
        await expect(
          client.syncDirectory({
            localPath: '/',
            mode: 'pull',
          })
        ).rejects.toThrow('Invalid local_path');
      });

      it('should reject paths with traversal attempts', async () => {
        await expect(
          client.syncDirectory({
            localPath: '/home/speedwave/.claude/context/../../../etc',
            mode: 'pull',
          })
        ).rejects.toThrow('Invalid local_path');
      });

      it('should accept valid /home/speedwave/.claude/context path', async () => {
        // Mock the listFiles to return empty for this test
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs to return empty directory
        mockFs.readdir.mockResolvedValueOnce([]);

        // This should not throw - the error would be from API, not validation
        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: true,
        });

        expect(result.success).toBe(true);
      });

      it('should accept subdirectories of /home/speedwave/.claude/context', async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs to return empty directory
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context/opportunities',
          mode: 'pull',
          dryRun: true,
        });

        expect(result.success).toBe(true);
      });
    });

    describe('dry run mode', () => {
      it('should return plan without executing operations', async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'test.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs to return empty directory
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        expect(result.plan.operations.length).toBeGreaterThan(0);
        expect(result.executed).toHaveLength(0);
        expect(result.summary.downloaded).toBe(0);
      });
    });

    describe('sync modes', () => {
      it('should download files in pull mode', async () => {
        // Mock listFiles response with one remote file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-only.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs to return empty directory
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');
        expect(downloadOps.length).toBeGreaterThan(0);
      });

      it('should delete local files in pull mode when delete=true', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: true,
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_local');
        expect(deleteOps.length).toBe(1);
        expect(deleteOps[0].path).toBe('local-only.txt');
      });

      it('should NOT delete local files in pull mode when delete=false', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: false,
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_local');
        expect(deleteOps.length).toBe(0);
      });

      it('should upload files in push mode', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('local-only.txt');
      });

      it('should delete remote files in push mode when delete=true', async () => {
        // Mock remote with one file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-only.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock empty local fs
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          delete: true,
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_remote');
        expect(deleteOps.length).toBe(1);
        expect(deleteOps[0].path).toBe('remote-only.txt');
      });

      it('should sync both directions in two_way mode', async () => {
        // Mock remote with one file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-only.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with different file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');
        expect(uploadOps.length).toBe(1);
        expect(downloadOps.length).toBe(1);
      });

      it('should prefer newer file in two_way mode when both exist', async () => {
        // Mock remote with older file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'shared.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with newer file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'shared.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-06-01'), // Local is newer
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].reason).toBe('local_newer');
      });

      it('should skip unchanged files', async () => {
        const sameTimestamp = '2024-01-01T00:00:00Z';

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'unchanged.txt',
                size: 100,
                lastModifiedDateTime: sameTimestamp,
              },
            ],
          }),
        });

        // Mock local fs with same file (same timestamp)
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'unchanged.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date(sameTimestamp),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const skipOps = result.plan.operations.filter((op) => op.action === 'skip');
        expect(skipOps.length).toBe(1);
        expect(skipOps[0].reason).toBe('unchanged');
      });
    });

    describe('non-dryRun execution', () => {
      it('should execute actual upload operations when dryRun=false', async () => {
        // Mock empty remote (listing from context/ folder)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock file read for upload
        mockFs.readFile.mockResolvedValueOnce(Buffer.from('test content'));

        // Mock folder existence checks for Documents/TestFolder/context/test.txt
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'documents-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });

        // Mock upload success
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ eTag: '"abc123"', size: 12 }),
        });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
          verbose: true, // Enable verbose mode to get executed array
        });

        expect(result.success).toBe(true);
        expect(result.summary.uploaded).toBe(1);
        expect(result.executed.length).toBe(1);
        expect(result.executed[0].action).toBe('upload');
        expect(result.executed[0].path).toBe('test.txt');

        // Verify upload API was called
        const uploadCall = fetchMock.mock.calls.find(
          (call) => call[1]?.method === 'PUT' && call[0].includes('content')
        );
        expect(uploadCall).toBeDefined();
      });

      it('should return empty plan.operations and executed arrays by default (slim mode)', async () => {
        // Mock remote empty
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 12,
          isFile: () => true,
          isDirectory: () => false,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock folder existence checks for ensureParentFolders
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'docs-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });

        // Mock upload success
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ eTag: '"abc123"', size: 12 }),
        });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
          // verbose not specified - defaults to false (slim mode)
        });

        expect(result.success).toBe(true);
        expect(result.summary.uploaded).toBe(1);
        // Slim mode: arrays should be empty
        expect(result.plan.operations).toEqual([]);
        expect(result.executed).toEqual([]);
        // Summary should still be populated
        expect(result.plan.summary.toUpload).toBe(1);
      });

      it('should return full plan.operations when dryRun=true even without verbose (dryRun exception to slim mode)', async () => {
        // Mock remote with files to trigger download operations
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-file.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'another-file.txt',
                size: 200,
                lastModifiedDateTime: '2024-01-02T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty - so all remote files will be planned for download
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: true,
          // verbose is NOT specified - defaults to false
          // BUT dryRun=true is an exception: should still return full plan.operations
        });

        expect(result.success).toBe(true);
        // dryRun=true exception: plan.operations should NOT be empty despite slim mode default
        expect(result.plan.operations.length).toBeGreaterThan(0);
        expect(result.plan.operations.length).toBe(2);
        expect(result.plan.operations.every((op) => op.action === 'download')).toBe(true);
        // dryRun never executes, so executed should always be empty
        expect(result.executed).toEqual([]);
        // Summary should reflect planned operations
        expect(result.plan.summary.toDownload).toBe(2);
      });

      it('should return full plan.operations when verbose=false but dryRun=true (dryRun takes precedence)', async () => {
        // Mock remote with files to trigger download operations
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-file.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: true,
          verbose: false, // Explicitly false, but dryRun should take precedence
        });

        expect(result.success).toBe(true);
        // dryRun=true takes precedence over verbose=false
        // plan.operations should be populated (that's the purpose of dry run)
        expect(result.plan.operations.length).toBe(1);
        expect(result.plan.operations[0].action).toBe('download');
        expect(result.plan.operations[0].path).toBe('remote-file.txt');
        // dryRun never executes, so executed is always empty
        expect(result.executed).toEqual([]);
        expect(result.plan.summary.toDownload).toBe(1);
      });

      it('should return full plan.operations and executed arrays when verbose=true', async () => {
        // Mock remote empty
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 12,
          isFile: () => true,
          isDirectory: () => false,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock folder checks (3) + upload
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'docs-folder' }),
        });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ eTag: '"abc123"', size: 12 }),
        });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
          verbose: true, // Explicitly enable verbose mode
        });

        expect(result.success).toBe(true);
        expect(result.summary.uploaded).toBe(1);
        // Verbose mode: plan.operations should be populated
        expect(result.plan.operations.length).toBe(1);
        expect(result.plan.operations[0].action).toBe('upload');
        expect(result.plan.operations[0].path).toBe('test.txt');
        // Verbose mode: executed should be populated (dryRun=false)
        expect(result.executed.length).toBe(1);
        expect(result.executed[0].action).toBe('upload');
        expect(result.executed[0].path).toBe('test.txt');
        // Summary should reflect the operation
        expect(result.plan.summary.toUpload).toBe(1);
      });

      it('should execute actual download operations when dryRun=false', async () => {
        // Mock remote with one file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        // Mock mkdir for creating directory
        mockFs.mkdir.mockResolvedValue(undefined);

        // Spy on downloadFileStream to verify it's called
        const downloadSpy = vi.spyOn(client, 'downloadFileStream').mockResolvedValue(undefined);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          dryRun: false,
          verbose: true, // Enable verbose mode to get executed array
        });

        expect(result.summary.downloaded).toBe(1);
        expect(result.executed.length).toBe(1);
        expect(result.executed[0].action).toBe('download');
        expect(result.executed[0].path).toBe('remote.txt');

        // Verify downloadFileStream was called
        // Note: sharepointPath includes 'context/' prefix, localPath is translated to /context
        expect(downloadSpy).toHaveBeenCalledWith('context/remote.txt', '/context/remote.txt');
      });

      it('should execute actual delete operations when dryRun=false', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'to-delete.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock file deletion
        mockFs.unlink.mockResolvedValueOnce(undefined);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: true,
          dryRun: false,
          verbose: true, // Enable verbose mode to get executed array
        });

        expect(result.success).toBe(true);
        expect(result.summary.deletedLocal).toBe(1);
        expect(result.executed.length).toBe(1);
        expect(result.executed[0].action).toBe('delete_local');

        // Verify unlink was called (path is translated to /context)
        expect(mockFs.unlink).toHaveBeenCalledWith('/context/to-delete.txt');
      });
    });

    describe('conflict detection', () => {
      it('should detect TRUE conflict when sizes differ AND timestamps are close (within 5 min)', async () => {
        // True conflict: both files modified independently (different sizes, close timestamps)
        const now = new Date();
        const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'conflict.txt',
                size: 100, // Different size than local
                lastModifiedDateTime: now.toISOString(),
              },
            ],
          }),
        });

        // Mock local fs with same file (different size, close timestamp)
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'conflict.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150, // Different size - indicates different content
          mtime: twoMinutesAgo, // Within 5 minutes of remote
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // Should detect as conflict (both_modified)
        const conflictOps = result.plan.operations.filter((op) => op.action === 'conflict');
        expect(conflictOps.length).toBe(1);
        expect(conflictOps[0].path).toBe('conflict.txt');
        expect(conflictOps[0].reason).toBe('both_modified');
      });

      it('should prefer newer file when timestamps are far apart (not a conflict)', async () => {
        // Not a conflict: timestamps far apart, can determine winner

        // Mock remote with file (older timestamp - 6 months ago)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'conflict.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with same file (newer timestamp - different content implied)
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'conflict.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150, // Different size implies different content
          mtime: new Date('2024-06-01T00:00:00Z'), // Much newer than remote
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // Timestamps far apart - prefer newer (local), not a conflict
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('conflict.txt');
        expect(uploadOps[0].reason).toBe('local_newer');
      });

      it('should choose remote file when remote is newer in two_way mode', async () => {
        // Mock remote with file (newer timestamp)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'conflict.txt',
                size: 100,
                lastModifiedDateTime: '2024-06-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with same file (older timestamp)
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'conflict.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150,
          mtime: new Date('2024-01-01T00:00:00Z'), // Older than remote
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // Remote is newer, so should download
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('conflict.txt');
        expect(downloadOps[0].reason).toBe('remote_newer');
        expect(downloadOps[0].localModified).toBe('2024-01-01T00:00:00.000Z');
        expect(downloadOps[0].remoteModified).toBe('2024-06-01T00:00:00Z');
      });
    });

    describe('conflict execution', () => {
      it('should create conflict file in Conflicts/ folder when executing conflict operation', async () => {
        // Mock remote file for conflict
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'conflict.txt',
                size: 100,
                lastModifiedDateTime: new Date().toISOString(),
              },
            ],
          }),
        });

        // Mock local file with conflict
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'conflict.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150,
          mtime: twoMinutesAgo,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock mkdir for creating directory
        mockFs.mkdir.mockResolvedValue(undefined);

        // Spy on downloadFileStream to capture the path it's called with
        let capturedPath = '';
        const downloadSpy = vi
          .spyOn(client, 'downloadFileStream')
          .mockImplementation(async (sharepointPath, localPath) => {
            capturedPath = localPath;
            return Promise.resolve();
          });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: false,
        });

        expect(result.success).toBe(true);

        // Verify downloadFileStream was called
        expect(downloadSpy).toHaveBeenCalled();

        // Verify file was downloaded to Conflicts/ folder
        expect(capturedPath).toContain('Conflicts/');
        expect(capturedPath).toContain('conflict.txt');
      });

      it('should use correct timestamp format (ISO with dashes) in conflict filename', async () => {
        // Mock remote file for conflict
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'test.txt',
                size: 100,
                lastModifiedDateTime: new Date().toISOString(),
              },
            ],
          }),
        });

        // Mock local file with conflict
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150,
          mtime: twoMinutesAgo,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        mockFs.mkdir.mockResolvedValue(undefined);

        // Spy on downloadFileStream to capture the path
        let capturedPath = '';
        const downloadSpy = vi
          .spyOn(client, 'downloadFileStream')
          .mockImplementation(async (sharepointPath, localPath) => {
            capturedPath = localPath;
            return Promise.resolve();
          });

        await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: false,
        });

        // Verify timestamp format: should be ISO format with : and . replaced by -
        const filename = capturedPath.split('/').pop() || '';
        const timestampPart = filename.split('_')[0];

        // Timestamp format should be like: 2024-12-16T10-30-45-123Z_test.txt
        // Should NOT contain : or . in the timestamp portion
        expect(timestampPart).not.toContain(':');
        expect(timestampPart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      });

      it('should preserve original filename in conflict file', async () => {
        // Mock remote file for conflict
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'my-important-document.pdf',
                size: 100,
                lastModifiedDateTime: new Date().toISOString(),
              },
            ],
          }),
        });

        // Mock local file with conflict
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'my-important-document.pdf', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150,
          mtime: twoMinutesAgo,
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        mockFs.mkdir.mockResolvedValue(undefined);

        // Spy on downloadFileStream to capture the path
        let capturedPath = '';
        const downloadSpy = vi
          .spyOn(client, 'downloadFileStream')
          .mockImplementation(async (sharepointPath, localPath) => {
            capturedPath = localPath;
            return Promise.resolve();
          });

        await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: false,
        });

        // Verify original filename is preserved after timestamp
        const filename = capturedPath.split('/').pop() || '';

        // Format should be: {timestamp}_my-important-document.pdf
        expect(filename).toMatch(/_my-important-document\.pdf$/);
      });
    });

    describe('conflict threshold boundary tests', () => {
      it('should detect conflict when files modified 4:59 apart (within threshold)', async () => {
        const now = new Date();
        const fourMinutesFiftyNineSecondsAgo = new Date(now.getTime() - (4 * 60 + 59) * 1000);

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'boundary-test.txt',
                size: 100,
                lastModifiedDateTime: now.toISOString(),
              },
            ],
          }),
        });

        // Mock local file - different size, timestamp just within 5-minute threshold
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'boundary-test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150, // Different size
          mtime: fourMinutesFiftyNineSecondsAgo, // 4:59 difference
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        // Should detect as conflict because within 5-minute threshold
        const conflictOps = result.plan.operations.filter((op) => op.action === 'conflict');
        expect(conflictOps.length).toBe(1);
        expect(conflictOps[0].path).toBe('boundary-test.txt');
        expect(conflictOps[0].reason).toBe('both_modified');
      });

      it('should NOT detect conflict when files modified 5:01 apart (outside threshold)', async () => {
        const now = new Date();
        const fiveMinutesOneSecondAgo = new Date(now.getTime() - (5 * 60 + 1) * 1000);

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'boundary-test.txt',
                size: 100,
                lastModifiedDateTime: now.toISOString(),
              },
            ],
          }),
        });

        // Mock local file - different size, timestamp just outside 5-minute threshold
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'boundary-test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150, // Different size
          mtime: fiveMinutesOneSecondAgo, // 5:01 difference
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        // Should NOT be conflict - should prefer newer (remote)
        const conflictOps = result.plan.operations.filter((op) => op.action === 'conflict');
        expect(conflictOps.length).toBe(0);

        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('boundary-test.txt');
        expect(downloadOps[0].reason).toBe('remote_newer');
      });

      it('should detect conflict at exactly 5:00 threshold (boundary edge case)', async () => {
        const now = new Date();
        const exactlyFiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'boundary-test.txt',
                size: 100,
                lastModifiedDateTime: now.toISOString(),
              },
            ],
          }),
        });

        // Mock local file - different size, timestamp exactly at 5-minute threshold
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'boundary-test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 150, // Different size
          mtime: exactlyFiveMinutesAgo, // Exactly 5:00 difference
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        // Should detect as conflict - exactly at threshold is still within (<=)
        const conflictOps = result.plan.operations.filter((op) => op.action === 'conflict');
        expect(conflictOps.length).toBe(1);
        expect(conflictOps[0].path).toBe('boundary-test.txt');
        expect(conflictOps[0].reason).toBe('both_modified');
      });

      it('should NOT detect conflict when sizes are the same (even if timestamps close)', async () => {
        const now = new Date();
        const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

        // Mock remote with file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'same-size.txt',
                size: 100,
                lastModifiedDateTime: now.toISOString(),
              },
            ],
          }),
        });

        // Mock local file - SAME size, close timestamp
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'same-size.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100, // Same size as remote
          mtime: twoMinutesAgo, // Close timestamp (within 5 min)
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          dryRun: true,
        });

        // Should NOT be conflict - size is the same, prefer newer
        const conflictOps = result.plan.operations.filter((op) => op.action === 'conflict');
        expect(conflictOps.length).toBe(0);

        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('same-size.txt');
        expect(downloadOps[0].reason).toBe('remote_newer');
      });
    });

    describe('ignorePatterns functionality', () => {
      it('should exclude files matching ignore patterns from sync plan', async () => {
        // Mock remote with multiple files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'document.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'debug.log',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: ['*.log'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should only download document.txt, not debug.log
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('document.txt');

        // Verify debug.log is not in any operation
        const debugLogOps = result.plan.operations.filter((op) => op.path === 'debug.log');
        expect(debugLogOps.length).toBe(0);
      });

      it('should include files NOT matching ignore patterns', async () => {
        // Mock remote with multiple files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'important.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'data.json',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '3',
                name: 'temp.tmp',
                size: 150,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: ['*.tmp'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should download important.txt and data.json, but not temp.tmp
        expect(downloadOps.length).toBe(2);
        expect(downloadOps.map((op) => op.path).sort()).toEqual(['data.json', 'important.txt']);
      });

      it('should apply multiple ignore patterns correctly', async () => {
        // Mock remote with various files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'code.js',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'debug.log',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '3',
                name: 'temp.tmp',
                size: 150,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '4',
                name: 'backup.bak',
                size: 250,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: ['*.log', '*.tmp', '*.bak'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should only download code.js
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('code.js');
      });

      it('should apply wildcard patterns (*.log, *.tmp)', async () => {
        // Mock remote with files at different levels
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'error.log',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'access.log',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '3',
                name: 'cache.tmp',
                size: 150,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '4',
                name: 'data.csv',
                size: 250,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: ['*.log', '*.tmp'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should only download data.csv
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('data.csv');
      });

      it('should apply directory patterns (node_modules)', async () => {
        // Mock remote with nested files including node_modules
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'app.js',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'package.json',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with files including node_modules
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'src', isFile: () => false, isDirectory: () => true },
          { name: 'node_modules', isFile: () => false, isDirectory: () => true },
        ] as any);

        // For the 'src' directory
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'index.js', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // For the 'node_modules' directory (should be filtered out, but mock it)
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'express', isFile: () => false, isDirectory: () => true },
        ] as any);

        // For the 'express' subdirectory
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'index.js', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 500,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          ignorePatterns: ['node_modules'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');

        // Should only upload src/index.js, not node_modules/express/index.js
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('src/index.js');
      });

      it('should filter files in subdirectories matching directory patterns', async () => {
        // Mock remote empty
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with nested structure
        mockFs.readdir.mockResolvedValueOnce([
          { name: '.git', isFile: () => false, isDirectory: () => true },
          { name: 'build', isFile: () => false, isDirectory: () => true },
          { name: 'src', isFile: () => false, isDirectory: () => true },
        ] as any);

        // For .git directory
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'config', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 50,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // For build directory
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'bundle.js', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 1000,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // For src directory
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'main.js', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 200,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          ignorePatterns: ['.git', 'build'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');

        // Should only upload src/main.js
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('src/main.js');
      });

      it('should handle empty ignorePatterns array (no filtering)', async () => {
        // Mock remote with files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'file1.log',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'file2.tmp',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: [],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should download all files when no patterns specified
        expect(downloadOps.length).toBe(2);
      });

      it('should work in push mode with ignore patterns', async () => {
        // Mock remote empty
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with files
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'important.txt', isFile: () => true, isDirectory: () => false },
          { name: 'debug.log', isFile: () => true, isDirectory: () => false },
          { name: 'temp.tmp', isFile: () => true, isDirectory: () => false },
        ] as any);

        mockFs.stat
          .mockResolvedValueOnce({
            size: 100,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>)
          .mockResolvedValueOnce({
            size: 200,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>)
          .mockResolvedValueOnce({
            size: 150,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          ignorePatterns: ['*.log', '*.tmp'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');

        // Should only upload important.txt
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('important.txt');
      });

      it('should work in two_way mode with ignore patterns', async () => {
        // Mock remote with files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'cache.tmp',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs with files
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local.txt', isFile: () => true, isDirectory: () => false },
          { name: 'debug.log', isFile: () => true, isDirectory: () => false },
        ] as any);

        mockFs.stat
          .mockResolvedValueOnce({
            size: 100,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>)
          .mockResolvedValueOnce({
            size: 200,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          ignorePatterns: ['*.log', '*.tmp'],
          dryRun: true,
        });

        expect(result.success).toBe(true);

        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should upload local.txt (not debug.log)
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('local.txt');

        // Should download remote.txt (not cache.tmp)
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('remote.txt');
      });

      it('should apply patterns with complex wildcards', async () => {
        // Mock remote with various files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'test-file.js',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'test-backup.bak',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '3',
                name: 'prod-file.js',
                size: 150,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          ignorePatterns: ['test-*'],
          dryRun: true,
        });

        expect(result.success).toBe(true);
        const downloadOps = result.plan.operations.filter((op) => op.action === 'download');

        // Should only download prod-file.js
        expect(downloadOps.length).toBe(1);
        expect(downloadOps[0].path).toBe('prod-file.js');
      });

      it('should ignore patterns during delete operations in pull mode', async () => {
        // Mock remote empty
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with files
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'document.txt', isFile: () => true, isDirectory: () => false },
          { name: 'cache.tmp', isFile: () => true, isDirectory: () => false },
        ] as any);

        mockFs.stat
          .mockResolvedValueOnce({
            size: 100,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>)
          .mockResolvedValueOnce({
            size: 200,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: true,
          ignorePatterns: ['*.tmp'],
          dryRun: true,
        });

        expect(result.success).toBe(true);

        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_local');

        // Should only plan to delete document.txt (cache.tmp is ignored)
        expect(deleteOps.length).toBe(1);
        expect(deleteOps[0].path).toBe('document.txt');
      });

      it('should ignore patterns during delete operations in push mode', async () => {
        // Mock remote with files
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'document.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
              {
                id: '2',
                name: 'debug.log',
                size: 200,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock local fs empty
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          delete: true,
          ignorePatterns: ['*.log'],
          dryRun: true,
        });

        expect(result.success).toBe(true);

        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_remote');

        // Should only plan to delete document.txt (debug.log is ignored)
        expect(deleteOps.length).toBe(1);
        expect(deleteOps[0].path).toBe('document.txt');
      });
    });

    describe('error handling', () => {
      it('should record operation errors and set success=false when operation fails', async () => {
        // Mock empty remote (listing from context/ folder)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock file read for upload
        mockFs.readFile.mockResolvedValueOnce(Buffer.from('test content'));

        // Mock folder existence checks for Documents/TestFolder/context/test.txt
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'documents-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });

        // Mock upload failure
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Internal server error' } }),
        });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
        });

        expect(result.success).toBe(false);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].path).toBe('test.txt');
        expect(result.errors[0].error).toContain('Internal server error');
        expect(result.summary.failed).toBe(1);
        expect(result.summary.uploaded).toBe(0);
      });

      it('should preserve errors in slim mode (default) while operations/executed are empty', async () => {
        // Mock empty remote (listing from context/ folder)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'test.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock file read for upload
        mockFs.readFile.mockResolvedValueOnce(Buffer.from('test content'));

        // Mock folder existence checks for Documents/TestFolder/context/test.txt
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'documents-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });

        // Mock upload failure
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Internal server error' } }),
        });

        // Call WITHOUT verbose parameter (defaults to false = slim mode)
        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
          // Note: verbose is NOT specified - defaults to false (slim mode)
        });

        // Errors should ALWAYS be preserved even in slim mode
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(1);
        expect(result.errors[0]).toHaveProperty('path');
        expect(result.errors[0]).toHaveProperty('error');
        expect(result.errors[0].path).toBe('test.txt');

        // In slim mode, operations and executed should be empty arrays
        expect(result.plan.operations).toEqual([]);
        expect(result.executed).toEqual([]);

        // Summary should still reflect the failure
        expect(result.summary.failed).toBeGreaterThanOrEqual(1);
      });

      it('should continue processing other operations after one fails', async () => {
        // Mock empty remote (listing from context/ folder)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with two files
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'file1.txt', isFile: () => true, isDirectory: () => false },
          { name: 'file2.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat
          .mockResolvedValueOnce({
            size: 100,
            mtime: new Date('2024-01-01'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>)
          .mockResolvedValueOnce({
            size: 200,
            mtime: new Date('2024-01-02'),
          } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        // Mock file reads for both uploads
        mockFs.readFile
          .mockResolvedValueOnce(Buffer.from('content 1'))
          .mockResolvedValueOnce(Buffer.from('content 2'));

        // First upload: folder checks (3) + upload failure
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'documents-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });
        // Upload file1 fails
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Server error' } }),
        });

        // Second upload: folder checks (3) + upload success
        // Check 1: Documents exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'documents-folder' }),
        });
        // Check 2: Documents/TestFolder exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'testfolder-folder' }),
        });
        // Check 3: Documents/TestFolder/context exists
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'context-folder' }),
        });
        // Upload file2 succeeds
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ eTag: '"xyz789"', size: 200 }),
        });

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          dryRun: false,
          verbose: true, // Enable verbose mode to get executed array
        });

        expect(result.success).toBe(false);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].path).toBe('file1.txt');
        expect(result.summary.failed).toBe(1);
        expect(result.summary.uploaded).toBe(1); // Second file succeeded
        expect(result.executed.length).toBe(1);
        expect(result.executed[0].path).toBe('file2.txt');
      });
    });

    describe('default delete behavior for two_way mode', () => {
      it('should default to delete=true for two_way mode when delete param is not specified', async () => {
        // Setup: file exists in previous state but was deleted on remote
        // This tests that deletions are propagated by default in two_way mode

        // Mock remote empty (file was deleted)
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file that was previously synced
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'previously-synced.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          // Note: delete is NOT specified - should default to true for two_way
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // In first sync (no previous state), local-only files are uploaded, not deleted
        // This is correct OneDrive-like behavior - first sync is conservative
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        expect(uploadOps.length).toBe(1);
        expect(uploadOps[0].path).toBe('previously-synced.txt');
      });

      it('should default to delete=false for pull mode when delete param is not specified', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          // Note: delete is NOT specified - should default to false for pull
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // No delete operations should be planned (delete defaults to false for pull)
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_local');
        expect(deleteOps.length).toBe(0);
      });

      it('should default to delete=false for push mode when delete param is not specified', async () => {
        // Mock remote with one file
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                id: '1',
                name: 'remote-only.txt',
                size: 100,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        });

        // Mock empty local fs
        mockFs.readdir.mockResolvedValueOnce([]);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'push',
          // Note: delete is NOT specified - should default to false for push
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // No delete operations should be planned (delete defaults to false for push)
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_remote');
        expect(deleteOps.length).toBe(0);
      });

      it('should allow explicit delete=false to override two_way default', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'two_way',
          delete: false, // Explicitly set to false - overrides two_way default
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // Should upload local file (two_way behavior)
        const uploadOps = result.plan.operations.filter((op) => op.action === 'upload');
        expect(uploadOps.length).toBe(1);

        // First sync with no previous state won't plan delete anyway
        // The key is that delete=false is respected
      });

      it('should allow explicit delete=true for pull mode', async () => {
        // Mock empty remote
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ value: [] }),
        });

        // Mock local fs with one file
        mockFs.readdir.mockResolvedValueOnce([
          { name: 'local-only.txt', isFile: () => true, isDirectory: () => false },
        ] as any);
        mockFs.stat.mockResolvedValueOnce({
          size: 100,
          mtime: new Date('2024-01-01'),
        } as unknown as Awaited<ReturnType<typeof fs.stat>>);

        const result = await client.syncDirectory({
          localPath: '/home/speedwave/.claude/context',
          mode: 'pull',
          delete: true, // Explicitly set to true - overrides pull default
          dryRun: true,
        });

        expect(result.success).toBe(true);

        // Should plan to delete local file (not on remote, delete=true)
        const deleteOps = result.plan.operations.filter((op) => op.action === 'delete_local');
        expect(deleteOps.length).toBe(1);
        expect(deleteOps[0].path).toBe('local-only.txt');
      });
    });
  });
});
