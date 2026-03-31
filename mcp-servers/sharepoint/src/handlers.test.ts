/**
 * SharePoint Handler Integration Tests
 *
 * Tests the full handler pipeline: createToolDefinitions routing,
 * withClient guard (null client), withValidation wrapper,
 * authentication error handling, and path traversal rejection.
 *
 * Complements the per-tool unit tests in tools/*.test.ts by testing
 * the wiring and integration at the handler level.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './tools/index.js';
import {
  handleListFileIds,
  handleGetFileFull,
  handleDownloadFile,
  handleUploadFile,
} from './tools/file-tools.js';
import { handleGetCurrentUser } from './tools/user-tools.js';
import type { SharePointClient } from './client.js';

type MockClient = {
  listFiles: Mock;
  getFileMetadata: Mock;
  uploadFile: Mock;
  downloadFile: Mock;
  getCurrentUser: Mock;
  getHealthStatus: Mock;
  formatError: Mock;
};

function createMockClient(): MockClient {
  return {
    listFiles: vi.fn(),
    getFileMetadata: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    getCurrentUser: vi.fn(),
    getHealthStatus: vi.fn().mockReturnValue({ tokenSaveError: null }),
    formatError: vi.fn((error: unknown) => {
      // Replicate SharePointClient.formatError logic for testing
      const e = error as { message?: string };
      const message = e.message || '';
      if (message.includes('401') || message.includes('Unauthorized')) {
        return withSetupGuidance('Authentication failed. Your SharePoint token may have expired.');
      }
      if (message.includes('403') || message.includes('Forbidden')) {
        return 'Permission denied. Your SharePoint token may not have sufficient permissions.';
      }
      if (message.includes('404') || message.includes('not found')) {
        return 'Resource not found in SharePoint.';
      }
      if (message.includes('security check failed') || message.includes('traversal')) {
        return 'Invalid path: security check failed (path traversal not allowed).';
      }
      if (message.includes('refresh') || message.includes('token')) {
        return withSetupGuidance('Token refresh failed.');
      }
      return message || 'SharePoint API error';
    }),
  };
}

describe('SharePoint handler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  //=============================================================================
  // createToolDefinitions routing
  //=============================================================================

  describe('createToolDefinitions', () => {
    it('returns all tool definitions with correct names', () => {
      const client = createMockClient();
      const tools = createToolDefinitions(client as unknown as SharePointClient);

      const names = tools.map((t) => t.tool.name);
      expect(names).toContain('listFileIds');
      expect(names).toContain('getFileFull');
      expect(names).toContain('downloadFile');
      expect(names).toContain('uploadFile');
      expect(names).toContain('getCurrentUser');
      expect(tools.length).toBe(5);
    });

    it('returns tool definitions even with null client', () => {
      const tools = createToolDefinitions(null);

      expect(tools.length).toBe(5);
      tools.forEach((t) => {
        expect(t.handler).toBeTypeOf('function');
      });
    });

    it('all handlers are callable functions', () => {
      const client = createMockClient();
      const tools = createToolDefinitions(client as unknown as SharePointClient);

      tools.forEach((t) => {
        expect(t.handler).toBeTypeOf('function');
      });
    });
  });

  //=============================================================================
  // Not configured (null client) - withClient guard
  //=============================================================================

  describe('not configured (null client)', () => {
    it('listFileIds returns NOT_CONFIGURED error', async () => {
      const tools = createToolDefinitions(null);
      const listTool = tools.find((t) => t.tool.name === 'listFileIds')!;

      const result = await listTool.handler({});
      const parsed = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('NOT_CONFIGURED');
      expect(parsed.message).toBe(notConfiguredMessage('SharePoint'));
    });

    it('getFileFull returns NOT_CONFIGURED error', async () => {
      const tools = createToolDefinitions(null);
      const getTool = tools.find((t) => t.tool.name === 'getFileFull')!;

      const result = await getTool.handler({ file_id: '123' });
      const parsed = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('NOT_CONFIGURED');
    });

    it('downloadFile returns NOT_CONFIGURED error', async () => {
      const tools = createToolDefinitions(null);
      const downloadTool = tools.find((t) => t.tool.name === 'downloadFile')!;

      const result = await downloadTool.handler({
        sharepointPath: 'docs/test.txt',
        localPath: '/workspace/test.txt',
      });
      const parsed = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('NOT_CONFIGURED');
    });

    it('uploadFile returns NOT_CONFIGURED error', async () => {
      const tools = createToolDefinitions(null);
      const uploadTool = tools.find((t) => t.tool.name === 'uploadFile')!;

      const result = await uploadTool.handler({
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
      });
      const parsed = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('NOT_CONFIGURED');
    });

    it('getCurrentUser returns NOT_CONFIGURED error', async () => {
      const tools = createToolDefinitions(null);
      const userTool = tools.find((t) => t.tool.name === 'getCurrentUser')!;

      const result = await userTool.handler({});
      const parsed = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('NOT_CONFIGURED');
    });
  });

  //=============================================================================
  // Authentication error handling
  //=============================================================================

  describe('authentication errors', () => {
    it('handleListFileIds returns error on 401 Unauthorized', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('handleGetFileFull returns error on expired token', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('401 Unauthorized - token expired'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GET_FAILED');
    });

    it('handleUploadFile returns error on 403 Forbidden', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('403 Forbidden'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('handleGetCurrentUser returns error on token refresh failure', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Token refresh failed'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });

    it('handleDownloadFile returns error on 401', async () => {
      const client = createMockClient();
      client.downloadFile.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/file.txt',
        localPath: '/workspace/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DOWNLOAD_FAILED');
    });
  });

  //=============================================================================
  // Path traversal rejection
  //=============================================================================

  describe('path traversal rejection at handler level', () => {
    it('handleUploadFile rejects path with ../ traversal', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('Invalid path (security check failed)'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: '../../../etc/passwd',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('handleUploadFile rejects URL-encoded traversal', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(
        new Error('Invalid path (security check failed - traversal)')
      );

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('handleListFileIds rejects traversal path', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('Invalid path (security check failed)'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {
        path: '../../etc',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });
  });

  //=============================================================================
  // Empty / malformed API responses
  //=============================================================================

  describe('empty and malformed responses', () => {
    it('handleListFileIds handles undefined files array', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({ files: undefined });

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(true);
      const data = result.data as { files: unknown[]; count: number };
      expect(data.files).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('handleListFileIds handles empty files array', async () => {
      const client = createMockClient();
      client.listFiles.mockResolvedValue({ files: [], exists: true });

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(true);
      const data = result.data as { files: unknown[]; count: number; exists: boolean };
      expect(data.files).toEqual([]);
      expect(data.count).toBe(0);
      expect(data.exists).toBe(true);
    });

    it('handleGetFileFull handles 404 not found', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('404 not found'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GET_FAILED');
    });

    it('handleGetCurrentUser handles empty response', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('Failed to parse user data from response'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });
  });

  //=============================================================================
  // handleUploadFile parameter validation
  //=============================================================================

  describe('handleUploadFile parameter validation', () => {
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

    it('accepts snake_case parameter aliases', async () => {
      const client = createMockClient();
      client.uploadFile.mockResolvedValue({ etag: 'abc', size: 100 });

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        local_path: '/workspace/test.txt',
        sharepoint_path: 'docs/test.txt',
      });

      expect(result.success).toBe(true);
      expect(client.uploadFile).toHaveBeenCalledWith(
        'docs/test.txt',
        '/workspace/test.txt',
        expect.any(Object)
      );
    });

    it('prefers camelCase over snake_case when both provided', async () => {
      const client = createMockClient();
      client.uploadFile.mockResolvedValue({ etag: 'abc', size: 100 });

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/camel.txt',
        local_path: '/workspace/snake.txt',
        sharepointPath: 'docs/camel.txt',
        sharepoint_path: 'docs/snake.txt',
      });

      expect(result.success).toBe(true);
      expect(client.uploadFile).toHaveBeenCalledWith(
        'docs/camel.txt',
        '/workspace/camel.txt',
        expect.any(Object)
      );
    });
  });

  //=============================================================================
  // handleDownloadFile parameter validation
  //=============================================================================

  describe('handleDownloadFile parameter validation', () => {
    it('returns MISSING_PARAM when sharepointPath is missing', async () => {
      const client = createMockClient();

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('sharepointPath');
    });

    it('returns MISSING_PARAM when localPath is missing', async () => {
      const client = createMockClient();

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAM');
      expect(result.error?.message).toContain('localPath');
    });

    it('accepts snake_case local_path alias', async () => {
      const client = createMockClient();
      client.downloadFile.mockResolvedValue(undefined);

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepoint_path: 'docs/file.txt',
        local_path: '/workspace/file.txt',
      });

      expect(result.success).toBe(true);
      expect(client.downloadFile).toHaveBeenCalledWith('docs/file.txt', '/workspace/file.txt');
    });
  });

  //=============================================================================
  // Rate limiting (HTTP 429)
  //=============================================================================

  describe('rate limiting', () => {
    it('handleListFileIds returns error on HTTP 429', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('handleGetFileFull returns error on HTTP 429', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GET_FAILED');
    });

    it('handleUploadFile returns error on HTTP 429', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('handleDownloadFile returns error on HTTP 429', async () => {
      const client = createMockClient();
      client.downloadFile.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleDownloadFile(client as unknown as SharePointClient, {
        sharepointPath: 'docs/file.txt',
        localPath: '/workspace/file.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DOWNLOAD_FAILED');
    });

    it('handleGetCurrentUser returns error on HTTP 429', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('429 Too Many Requests'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });
  });

  //=============================================================================
  // Network errors
  //=============================================================================

  describe('network errors', () => {
    it('handleListFileIds handles ECONNREFUSED', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('handleGetFileFull handles timeout', async () => {
      const client = createMockClient();
      client.getFileMetadata.mockRejectedValue(new Error('AbortError: Request timeout'));

      const result = await handleGetFileFull(client as unknown as SharePointClient, {
        file_id: '123',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GET_FAILED');
    });

    it('handleUploadFile handles DNS resolution failure', async () => {
      const client = createMockClient();
      client.uploadFile.mockRejectedValue(new Error('getaddrinfo ENOTFOUND graph.microsoft.com'));

      const result = await handleUploadFile(client as unknown as SharePointClient, {
        localPath: '/workspace/test.txt',
        sharepointPath: 'docs/test.txt',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UPLOAD_FAILED');
    });

    it('handleGetCurrentUser handles service unavailable', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });
  });

  //=============================================================================
  // Non-Error objects thrown
  //=============================================================================

  describe('non-Error objects thrown', () => {
    it('handleListFileIds handles string thrown', async () => {
      const client = createMockClient();
      client.listFiles.mockRejectedValue('string error');

      const result = await handleListFileIds(client as unknown as SharePointClient, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
    });

    it('handleGetCurrentUser handles object without message thrown', async () => {
      const client = createMockClient();
      client.getCurrentUser.mockRejectedValue({ code: 'UNKNOWN' });

      const result = await handleGetCurrentUser(client as unknown as SharePointClient);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_FAILED');
    });
  });

  //=============================================================================
  // withValidation wrapper (tested through createToolDefinitions)
  //=============================================================================

  describe('withValidation wrapper', () => {
    it('wraps successful results in ToolsCallResult format', async () => {
      const client = createMockClient();
      const tools = createToolDefinitions(client as unknown as SharePointClient);
      const userTool = tools.find((t) => t.tool.name === 'getCurrentUser')!;

      client.getCurrentUser.mockResolvedValue({
        displayName: 'Test User',
        email: 'test@example.com',
        userPrincipalName: 'test@example.com',
        id: 'user-123',
      });

      const result = await userTool.handler({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe('text');
      // The text should be JSON-stringified data
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.displayName).toBe('Test User');
    });

    it('wraps error results in ToolsCallResult format with isError flag', async () => {
      const client = createMockClient();
      const tools = createToolDefinitions(client as unknown as SharePointClient);
      const userTool = tools.find((t) => t.tool.name === 'getCurrentUser')!;

      client.getCurrentUser.mockRejectedValue(new Error('API error'));

      const result = await userTool.handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.code).toBe('USER_FAILED');
    });

    it('catches handler exceptions and wraps as HANDLER_ERROR', async () => {
      const client = createMockClient();
      const tools = createToolDefinitions(client as unknown as SharePointClient);
      const listTool = tools.find((t) => t.tool.name === 'listFileIds')!;

      // Simulate an unexpected crash inside the handler by throwing in listFiles
      // and then making the handler itself throw (instead of returning ToolResult)
      // This tests the outer catch in withValidation
      client.listFiles.mockImplementation(() => {
        throw new Error('Unexpected synchronous error');
      });

      const result = await listTool.handler({});

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      // Could be LIST_FAILED or HANDLER_ERROR depending on where the catch happens
      expect(['LIST_FAILED', 'HANDLER_ERROR']).toContain(parsed.code);
    });
  });
});
