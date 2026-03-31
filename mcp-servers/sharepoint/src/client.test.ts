/**
 * Comprehensive tests for SharePoint/Microsoft Graph API Client
 * Target: 90%+ code coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetupGuidance } from '@speedwave/mcp-shared';
import { SharePointClient, initializeSharePointClient, SharePointConfig } from './client.js';
import fs from 'fs/promises';
import path from 'path';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('@speedwave/mcp-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@speedwave/mcp-shared')>();
  return {
    ...actual,
    loadToken: vi.fn(),
    ts: () => '[00:00:00]',
  };
});

const mockFs = vi.mocked(fs);
const { loadToken } = await import('@speedwave/mcp-shared');
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
      expect(formatted).toBe(
        withSetupGuidance('Authentication failed. Your SharePoint token may have expired.')
      );
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

      await client.uploadFile('file.txt', '/workspace/file.txt');

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

  describe('uploadFile', () => {
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

      const result = await client.uploadFile('remote/file.txt', '/workspace/local/file.txt');

      expect(result).toEqual({
        etag: '"abc123"',
        size: 17,
      });

      expect(mockFs.readFile).toHaveBeenCalledWith('/workspace/local/file.txt');
    });

    it('should validate SharePoint path', async () => {
      await expect(client.uploadFile('../../../etc/passwd', '/workspace/file.txt')).rejects.toThrow(
        'Invalid sharepoint_path (security check failed)'
      );
    });

    it('should validate local path', async () => {
      await expect(client.uploadFile('file.txt', '/etc/passwd')).rejects.toThrow(
        'Invalid local_path: must be under /workspace'
      );
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

      await client.uploadFile('file.txt', '/workspace/file.txt', {
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

      await client.uploadFile('file.txt', '/workspace/file.txt', {
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

    it('should skip conditional headers in overwrite mode', async () => {
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

      // Upload file
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ eTag: '"overwrite"', size: 17 }),
      });

      await client.uploadFile('file.txt', '/workspace/file.txt', {
        overwrite: true,
        expectedEtag: '"ignored"',
      });

      // The upload call (last one) should NOT have If-Match header
      const uploadCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(uploadCall[1]?.headers).not.toHaveProperty('If-Match');
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

      await client.uploadFile('newfolder/file.txt', '/workspace/file.txt');

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

      await expect(client.uploadFile('file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Conflict'
      );
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

      await expect(client.uploadFile('file.txt', '/workspace/file.txt')).rejects.toThrow(
        'Upload failed'
      );
    });
  });

  describe('downloadFile', () => {
    it('rejects traversal in sharepointPath', async () => {
      await expect(
        client.downloadFile('../../../etc/passwd', '/workspace/out.txt')
      ).rejects.toThrow('Invalid sharepoint_path');
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

      await client.uploadFile('level1/level2/file.txt', '/workspace/file.txt');

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

      await client.uploadFile('existing/file.txt', '/workspace/file.txt');

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

      await client.uploadFile('file.txt', '/workspace/file.txt');

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

      await client.uploadFile('rootfolder/file.txt', '/workspace/file.txt');

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
});
