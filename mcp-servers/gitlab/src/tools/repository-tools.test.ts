/**
 * Comprehensive tests for repository-tools.ts
 * Tests all 3 repository tools: get_tree, get_file, get_blame
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createRepositoryTools } from './repository-tools.js';
import type { GitLabClient } from '../client.js';

// Mock client type with all repository-related methods
type MockClient = {
  getTree: Mock;
  getFile: Mock;
  getBlame: Mock;
};

describe('createRepositoryTools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      getTree: vi.fn(),
      getFile: vi.fn(),
      getBlame: vi.fn(),
    };
  });

  describe('getTree', () => {
    it('should get repository tree successfully', async () => {
      const mockTree = [
        {
          id: 'abc123',
          name: 'README.md',
          type: 'blob',
          path: 'README.md',
          mode: '100644',
        },
        {
          id: 'def456',
          name: 'src',
          type: 'tree',
          path: 'src',
          mode: '040000',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', {});
    });

    it('should get tree with path parameter', async () => {
      const mockTree = [
        {
          id: 'ghi789',
          name: 'index.ts',
          type: 'blob',
          path: 'src/index.ts',
          mode: '100644',
        },
        {
          id: 'jkl012',
          name: 'utils.ts',
          type: 'blob',
          path: 'src/utils.ts',
          mode: '100644',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 'project-1', path: 'src' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', { path: 'src' });
    });

    it('should get tree with ref parameter', async () => {
      const mockTree = [
        {
          id: 'mno345',
          name: 'config.json',
          type: 'blob',
          path: 'config.json',
          mode: '100644',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 'project-1', ref: 'develop' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', { ref: 'develop' });
    });

    it('should get tree with recursive parameter', async () => {
      const mockTree = [
        {
          id: 'abc123',
          name: 'README.md',
          type: 'blob',
          path: 'README.md',
          mode: '100644',
        },
        {
          id: 'def456',
          name: 'index.ts',
          type: 'blob',
          path: 'src/index.ts',
          mode: '100644',
        },
        {
          id: 'ghi789',
          name: 'component.tsx',
          type: 'blob',
          path: 'src/components/component.tsx',
          mode: '100644',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 'project-1', recursive: true });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', { recursive: true });
    });

    it('should get tree with limit parameter', async () => {
      const mockTree = Array.from({ length: 50 }, (_, i) => ({
        id: `item${i}`,
        name: `file${i}.txt`,
        type: 'blob',
        path: `file${i}.txt`,
        mode: '100644',
      }));

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 'project-1', limit: 50 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', { limit: 50 });
    });

    it('should get tree with multiple optional parameters', async () => {
      const mockTree = [
        {
          id: 'xyz999',
          name: 'helper.ts',
          type: 'blob',
          path: 'src/utils/helper.ts',
          mode: '100644',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        path: 'src/utils',
        ref: 'feature/new-feature',
        recursive: true,
        limit: 100,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith('project-1', {
        path: 'src/utils',
        ref: 'feature/new-feature',
        recursive: true,
        limit: 100,
      });
    });

    it('should handle errors when getting tree', async () => {
      mockClient.getTree.mockRejectedValue(new Error('Project not found'));

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockTree = [
        {
          id: 'test123',
          name: 'test.txt',
          type: 'blob',
          path: 'test.txt',
          mode: '100644',
        },
      ];

      mockClient.getTree.mockResolvedValue(mockTree);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      const result = await handler!({ project_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockTree, null, 2) }],
      });
      expect(mockClient.getTree).toHaveBeenCalledWith(123, {});
    });
  });

  describe('getFile', () => {
    it('should get file content successfully', async () => {
      const mockFile = {
        file_name: 'README.md',
        file_path: 'README.md',
        size: 1024,
        encoding: 'base64',
        content: 'IyBQcm9qZWN0IFJlYWRtZQ==',
        content_sha256: 'abc123def456',
        ref: 'main',
        blob_id: 'blob123',
        commit_id: 'commit456',
        last_commit_id: 'commit789',
      };

      mockClient.getFile.mockResolvedValue(mockFile);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', file_path: 'README.md' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFile, null, 2) }],
      });
      expect(mockClient.getFile).toHaveBeenCalledWith('project-1', 'README.md', undefined);
    });

    it('should get file with ref parameter', async () => {
      const mockFile = {
        file_name: 'config.json',
        file_path: 'config/config.json',
        size: 512,
        encoding: 'base64',
        content: 'eyJrZXkiOiJ2YWx1ZSJ9',
        content_sha256: 'sha256hash',
        ref: 'develop',
        blob_id: 'blob789',
        commit_id: 'commit012',
        last_commit_id: 'commit345',
      };

      mockClient.getFile.mockResolvedValue(mockFile);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        file_path: 'config/config.json',
        ref: 'develop',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFile, null, 2) }],
      });
      expect(mockClient.getFile).toHaveBeenCalledWith('project-1', 'config/config.json', 'develop');
    });

    it('should get file from specific commit SHA', async () => {
      const mockFile = {
        file_name: 'index.ts',
        file_path: 'src/index.ts',
        size: 2048,
        encoding: 'base64',
        content: 'Y29uc3QgYXBwID0gIkhlbGxvIjs=',
        content_sha256: 'fileshasum',
        ref: 'abc123def456',
        blob_id: 'blob999',
        commit_id: 'abc123def456',
        last_commit_id: 'abc123def456',
      };

      mockClient.getFile.mockResolvedValue(mockFile);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        file_path: 'src/index.ts',
        ref: 'abc123def456',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFile, null, 2) }],
      });
      expect(mockClient.getFile).toHaveBeenCalledWith('project-1', 'src/index.ts', 'abc123def456');
    });

    it('should handle errors when getting file', async () => {
      mockClient.getFile.mockRejectedValue(new Error('File not found'));

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      const result = await handler!({ project_id: 'project-1', file_path: 'nonexistent.txt' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockFile = {
        file_name: 'test.js',
        file_path: 'test.js',
        size: 256,
        encoding: 'base64',
        content: 'dGVzdA==',
        content_sha256: 'testsha',
        ref: 'main',
        blob_id: 'testblob',
        commit_id: 'testcommit',
        last_commit_id: 'testlast',
      };

      mockClient.getFile.mockResolvedValue(mockFile);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      const result = await handler!({ project_id: 456, file_path: 'test.js' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockFile, null, 2) }],
      });
      expect(mockClient.getFile).toHaveBeenCalledWith(456, 'test.js', undefined);
    });
  });

  describe('getBlame', () => {
    it('should get file blame successfully', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            message: 'Initial commit',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            authored_date: '2024-01-01T00:00:00Z',
            committer_name: 'John Doe',
            committer_email: 'john@example.com',
            committed_date: '2024-01-01T00:00:00Z',
          },
          lines: ['console.log("Hello");', 'console.log("World");'],
        },
        {
          commit: {
            id: 'commit2',
            message: 'Update logging',
            author_name: 'Jane Doe',
            author_email: 'jane@example.com',
            authored_date: '2024-01-02T00:00:00Z',
            committer_name: 'Jane Doe',
            committer_email: 'jane@example.com',
            committed_date: '2024-01-02T00:00:00Z',
          },
          lines: ['console.log("Updated");'],
        },
      ];

      mockClient.getBlame.mockResolvedValue(mockBlame);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', file_path: 'src/index.ts' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBlame, null, 2) }],
      });
      expect(mockClient.getBlame).toHaveBeenCalledWith('project-1', 'src/index.ts', undefined);
    });

    it('should get blame with ref parameter', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit3',
            message: 'Feature branch changes',
            author_name: 'Developer',
            author_email: 'dev@example.com',
            authored_date: '2024-01-03T00:00:00Z',
            committer_name: 'Developer',
            committer_email: 'dev@example.com',
            committed_date: '2024-01-03T00:00:00Z',
          },
          lines: ['// New feature', 'const feature = true;'],
        },
      ];

      mockClient.getBlame.mockResolvedValue(mockBlame);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        file_path: 'src/feature.ts',
        ref: 'feature/new-feature',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBlame, null, 2) }],
      });
      expect(mockClient.getBlame).toHaveBeenCalledWith(
        'project-1',
        'src/feature.ts',
        'feature/new-feature'
      );
    });

    it('should get blame from specific commit', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'abc123',
            message: 'Historic change',
            author_name: 'Past Dev',
            author_email: 'past@example.com',
            authored_date: '2023-12-01T00:00:00Z',
            committer_name: 'Past Dev',
            committer_email: 'past@example.com',
            committed_date: '2023-12-01T00:00:00Z',
          },
          lines: ['// Old code', 'legacyFunction();'],
        },
      ];

      mockClient.getBlame.mockResolvedValue(mockBlame);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        file_path: 'legacy/old.ts',
        ref: 'abc123',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBlame, null, 2) }],
      });
      expect(mockClient.getBlame).toHaveBeenCalledWith('project-1', 'legacy/old.ts', 'abc123');
    });

    it('should handle errors when getting blame', async () => {
      mockClient.getBlame.mockRejectedValue(new Error('File has no commits'));

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      const result = await handler!({ project_id: 'project-1', file_path: 'empty.txt' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: File has no commits' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'test789',
            message: 'Test commit',
            author_name: 'Tester',
            author_email: 'test@example.com',
            authored_date: '2024-01-10T00:00:00Z',
            committer_name: 'Tester',
            committer_email: 'test@example.com',
            committed_date: '2024-01-10T00:00:00Z',
          },
          lines: ['test line'],
        },
      ];

      mockClient.getBlame.mockResolvedValue(mockBlame);

      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      const result = await handler!({ project_id: 789, file_path: 'test.ts' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBlame, null, 2) }],
      });
      expect(mockClient.getBlame).toHaveBeenCalledWith(789, 'test.ts', undefined);
    });
  });

  describe('unconfigured client', () => {
    it('should return error for get_tree when client is null', async () => {
      const tools = createRepositoryTools(null);
      const handler = tools.find((t) => t.tool.name === 'getTree')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });

    it('should return error for get_file when client is null', async () => {
      const tools = createRepositoryTools(null);
      const handler = tools.find((t) => t.tool.name === 'getFile')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', file_path: 'README.md' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });

    it('should return error for get_blame when client is null', async () => {
      const tools = createRepositoryTools(null);
      const handler = tools.find((t) => t.tool.name === 'getBlame')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', file_path: 'src/index.ts' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });

    it('should return 3 tools when client is null', () => {
      const tools = createRepositoryTools(null);

      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.tool.name)).toEqual(['getTree', 'getFile', 'getBlame']);
    });
  });

  describe('tool definitions', () => {
    it('should return 3 tools when client is configured', () => {
      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);

      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.tool.name)).toEqual(['getTree', 'getFile', 'getBlame']);
    });

    it('should have correct tool definition for get_tree', () => {
      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getTree')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('getTree');
      expect(tool?.description).toBe('Get repository file tree');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('path');
      expect(tool?.inputSchema.properties).toHaveProperty('ref');
      expect(tool?.inputSchema.properties).toHaveProperty('recursive');
      expect(tool?.inputSchema.properties).toHaveProperty('limit');
    });

    it('should have correct tool definition for get_file', () => {
      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getFile')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('getFile');
      expect(tool?.description).toBe('Get file content from repository');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'file_path']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('file_path');
      expect(tool?.inputSchema.properties).toHaveProperty('ref');
    });

    it('should have correct tool definition for get_blame', () => {
      const tools = createRepositoryTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getBlame')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('getBlame');
      expect(tool?.description).toBe('Get git blame for a file');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'file_path']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('file_path');
      expect(tool?.inputSchema.properties).toHaveProperty('ref');
    });
  });
});
