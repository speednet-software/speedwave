/**
 * Comprehensive tests for branch-tools.ts
 * Tests all 5 branch tools: list_branches, get_branch, create_branch, delete_branch, compare_branches
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createBranchTools } from './branch-tools.js';
import type { GitLabClient } from '../client.js';

// Mock client type with all branch-related methods
type MockClient = {
  listBranches: Mock;
  getBranch: Mock;
  createBranch: Mock;
  deleteBranch: Mock;
  compareBranches: Mock;
};

describe('createBranchTools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      listBranches: vi.fn(),
      getBranch: vi.fn(),
      createBranch: vi.fn(),
      deleteBranch: vi.fn(),
      compareBranches: vi.fn(),
    };
  });

  describe('listBranches', () => {
    it('should list branches successfully', async () => {
      const mockBranches = [
        {
          name: 'main',
          commit: {
            id: 'abc123',
            short_id: 'abc123',
            title: 'Initial commit',
            message: 'Initial commit',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          protected: true,
          merged: false,
          default: true,
          web_url: 'https://gitlab.com/project/repo/-/tree/main',
        },
        {
          name: 'develop',
          commit: {
            id: 'def456',
            short_id: 'def456',
            title: 'Feature commit',
            message: 'Feature commit',
            author_name: 'Jane Doe',
            author_email: 'jane@example.com',
            created_at: '2024-01-02T00:00:00Z',
          },
          protected: false,
          merged: false,
          default: false,
          web_url: 'https://gitlab.com/project/repo/-/tree/develop',
        },
      ];

      mockClient.listBranches.mockResolvedValue(mockBranches);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranches, null, 2) }],
      });
      expect(mockClient.listBranches).toHaveBeenCalledWith('project-1', {});
    });

    it('should list branches with search parameter', async () => {
      const mockBranches = [
        {
          name: 'feature/auth',
          commit: {
            id: 'abc123',
            short_id: 'abc123',
            title: 'Auth feature',
            message: 'Auth feature',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          protected: false,
          merged: false,
          default: false,
          web_url: 'https://gitlab.com/project/repo/-/tree/feature/auth',
        },
      ];

      mockClient.listBranches.mockResolvedValue(mockBranches);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      const result = await handler!({ project_id: 'project-1', search: 'feature' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranches, null, 2) }],
      });
      expect(mockClient.listBranches).toHaveBeenCalledWith('project-1', { search: 'feature' });
    });

    it('should list branches with limit parameter', async () => {
      const mockBranches = Array.from({ length: 10 }, (_, i) => ({
        name: `branch-${i}`,
        commit: {
          id: `commit-${i}`,
          short_id: `commit-${i}`,
          title: `Commit ${i}`,
          message: `Commit ${i}`,
          author_name: 'Author',
          author_email: 'author@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        web_url: `https://gitlab.com/project/repo/-/tree/branch-${i}`,
      }));

      mockClient.listBranches.mockResolvedValue(mockBranches);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      const result = await handler!({ project_id: 'project-1', limit: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranches, null, 2) }],
      });
      expect(mockClient.listBranches).toHaveBeenCalledWith('project-1', { limit: 10 });
    });

    it('should handle errors when listing branches', async () => {
      mockClient.listBranches.mockRejectedValue(new Error('API error'));

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      const result = await handler!({ project_id: 'project-1' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: API error' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockBranches = [
        {
          name: 'main',
          commit: {
            id: 'abc123',
            short_id: 'abc123',
            title: 'Initial commit',
            message: 'Initial commit',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          protected: true,
          merged: false,
          default: true,
          web_url: 'https://gitlab.com/project/repo/-/tree/main',
        },
      ];

      mockClient.listBranches.mockResolvedValue(mockBranches);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      const result = await handler!({ project_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranches, null, 2) }],
      });
      expect(mockClient.listBranches).toHaveBeenCalledWith(123, {});
    });
  });

  describe('getBranch', () => {
    it('should get branch successfully', async () => {
      const mockBranch = {
        name: 'main',
        commit: {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Latest commit',
          message: 'Latest commit',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        protected: true,
        merged: false,
        default: true,
        web_url: 'https://gitlab.com/project/repo/-/tree/main',
      };

      mockClient.getBranch.mockResolvedValue(mockBranch);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', branch: 'main' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranch, null, 2) }],
      });
      expect(mockClient.getBranch).toHaveBeenCalledWith('project-1', 'main');
    });

    it('should handle errors when getting branch', async () => {
      const error = { response: { status: 404 } };
      mockClient.getBranch.mockRejectedValue(error);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;

      const result = await handler!({ project_id: 'project-1', branch: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockBranch = {
        name: 'develop',
        commit: {
          id: 'def456',
          short_id: 'def456',
          title: 'Test commit',
          message: 'Test commit',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        web_url: 'https://gitlab.com/project/repo/-/tree/develop',
      };

      mockClient.getBranch.mockResolvedValue(mockBranch);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;

      const result = await handler!({ project_id: 456, branch: 'develop' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranch, null, 2) }],
      });
      expect(mockClient.getBranch).toHaveBeenCalledWith(456, 'develop');
    });
  });

  describe('createBranch', () => {
    it('should create branch successfully', async () => {
      const mockBranch = {
        name: 'feature/new-feature',
        commit: {
          id: 'xyz789',
          short_id: 'xyz789',
          title: 'Base commit',
          message: 'Base commit',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        web_url: 'https://gitlab.com/project/repo/-/tree/feature/new-feature',
      };

      mockClient.createBranch.mockResolvedValue(mockBranch);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({
        project_id: 'project-1',
        branch: 'feature/new-feature',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranch, null, 2) }],
      });
      expect(mockClient.createBranch).toHaveBeenCalledWith(
        'project-1',
        'feature/new-feature',
        'main'
      );
    });

    it('should create branch from commit SHA', async () => {
      const mockBranch = {
        name: 'hotfix/bug-fix',
        commit: {
          id: 'abc123def456',
          short_id: 'abc123de',
          title: 'Fix bug',
          message: 'Fix bug',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-03T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        web_url: 'https://gitlab.com/project/repo/-/tree/hotfix/bug-fix',
      };

      mockClient.createBranch.mockResolvedValue(mockBranch);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        branch: 'hotfix/bug-fix',
        ref: 'abc123def456',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranch, null, 2) }],
      });
      expect(mockClient.createBranch).toHaveBeenCalledWith(
        'project-1',
        'hotfix/bug-fix',
        'abc123def456'
      );
    });

    it('should handle errors when creating branch', async () => {
      mockClient.createBranch.mockRejectedValue(new Error('Branch already exists'));

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        branch: 'existing-branch',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Branch already exists' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockBranch = {
        name: 'test-branch',
        commit: {
          id: 'test123',
          short_id: 'test123',
          title: 'Test',
          message: 'Test',
          author_name: 'Test User',
          author_email: 'test@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        web_url: 'https://gitlab.com/project/repo/-/tree/test-branch',
      };

      mockClient.createBranch.mockResolvedValue(mockBranch);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;

      const result = await handler!({
        project_id: 789,
        branch: 'test-branch',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockBranch, null, 2) }],
      });
      expect(mockClient.createBranch).toHaveBeenCalledWith(789, 'test-branch', 'main');
    });
  });

  describe('deleteBranch', () => {
    it('should delete branch successfully', async () => {
      mockClient.deleteBranch.mockResolvedValue(undefined);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', branch: 'old-branch' });

      const expectedResult = { success: true, message: 'Branch old-branch deleted' };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expectedResult, null, 2) }],
      });
      expect(mockClient.deleteBranch).toHaveBeenCalledWith('project-1', 'old-branch');
    });

    it('should handle errors when deleting branch', async () => {
      mockClient.deleteBranch.mockRejectedValue(new Error('Cannot delete protected branch'));

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;

      const result = await handler!({ project_id: 'project-1', branch: 'main' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Cannot delete protected branch' }],
        isError: true,
      });
    });

    it('should handle branch not found error', async () => {
      const error = { response: { status: 404 } };
      mockClient.deleteBranch.mockRejectedValue(error);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;

      const result = await handler!({ project_id: 'project-1', branch: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      mockClient.deleteBranch.mockResolvedValue(undefined);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;

      const result = await handler!({ project_id: 999, branch: 'feature-branch' });

      const expectedResult = { success: true, message: 'Branch feature-branch deleted' };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expectedResult, null, 2) }],
      });
      expect(mockClient.deleteBranch).toHaveBeenCalledWith(999, 'feature-branch');
    });
  });

  describe('compareBranches', () => {
    it('should compare branches successfully', async () => {
      const mockComparison = {
        commits: [
          {
            id: 'commit1',
            short_id: 'commit1',
            title: 'First commit',
            message: 'First commit message',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          {
            id: 'commit2',
            short_id: 'commit2',
            title: 'Second commit',
            message: 'Second commit message',
            author_name: 'Jane Doe',
            author_email: 'jane@example.com',
            created_at: '2024-01-02T00:00:00Z',
          },
        ],
        diffs: [
          {
            old_path: 'file1.txt',
            new_path: 'file1.txt',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
          {
            old_path: 'file2.txt',
            new_path: 'file2.txt',
            diff: '@@ -1 +1 @@\n-old2\n+new2',
          },
        ],
        compare_timeout: false,
        compare_same_ref: false,
      };

      mockClient.compareBranches.mockResolvedValue(mockComparison);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', from: 'main', to: 'develop' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockComparison, null, 2) }],
      });
      expect(mockClient.compareBranches).toHaveBeenCalledWith('project-1', 'main', 'develop');
    });

    it('should compare branches with commit SHAs', async () => {
      const mockComparison = {
        commits: [
          {
            id: 'abc123',
            short_id: 'abc123',
            title: 'Commit between SHAs',
            message: 'Commit message',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        diffs: [
          {
            old_path: 'file.txt',
            new_path: 'file.txt',
            diff: '@@ -1 +1 @@\n-before\n+after',
          },
        ],
        compare_timeout: false,
        compare_same_ref: false,
      };

      mockClient.compareBranches.mockResolvedValue(mockComparison);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      const result = await handler!({
        project_id: 'project-1',
        from: 'abc123def456',
        to: 'def456abc123',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockComparison, null, 2) }],
      });
      expect(mockClient.compareBranches).toHaveBeenCalledWith(
        'project-1',
        'abc123def456',
        'def456abc123'
      );
    });

    it('should handle comparison with no differences', async () => {
      const mockComparison = {
        commits: [],
        diffs: [],
        compare_timeout: false,
        compare_same_ref: true,
      };

      mockClient.compareBranches.mockResolvedValue(mockComparison);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      const result = await handler!({ project_id: 'project-1', from: 'main', to: 'main' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockComparison, null, 2) }],
      });
    });

    it('should handle errors when comparing branches', async () => {
      const error = { response: { status: 404 } };
      mockClient.compareBranches.mockRejectedValue(error);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      const result = await handler!({ project_id: 'project-1', from: 'main', to: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should accept numeric project_id', async () => {
      const mockComparison = {
        commits: [],
        diffs: [],
        compare_timeout: false,
        compare_same_ref: false,
      };

      mockClient.compareBranches.mockResolvedValue(mockComparison);

      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      const result = await handler!({ project_id: 111, from: 'branch-a', to: 'branch-b' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockComparison, null, 2) }],
      });
      expect(mockClient.compareBranches).toHaveBeenCalledWith(111, 'branch-a', 'branch-b');
    });
  });

  describe('unconfigured client', () => {
    it('should return error for list_branches when client is null', async () => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('should return error for get_branch when client is null', async () => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', branch: 'main' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('should return error for create_branch when client is null', async () => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', branch: 'new-branch', ref: 'main' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('should return error for delete_branch when client is null', async () => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', branch: 'old-branch' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('should return error for compare_branches when client is null', async () => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({ project_id: 'project-1', from: 'main', to: 'develop' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('should return 5 tools when client is null', () => {
      const tools = createBranchTools(null);

      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listBranches',
        'getBranch',
        'createBranch',
        'deleteBranch',
        'compareBranches',
      ]);
    });
  });

  describe('tool definitions', () => {
    it('should return 5 tools when client is configured', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);

      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listBranches',
        'getBranch',
        'createBranch',
        'deleteBranch',
        'compareBranches',
      ]);
    });

    it('should have correct tool definition for list_branches', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listBranches')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('listBranches');
      expect(tool?.description).toBe('List branches in a project');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('search');
      expect(tool?.inputSchema.properties).toHaveProperty('limit');
    });

    it('should have correct tool definition for get_branch', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getBranch')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('getBranch');
      expect(tool?.description).toBe('Get details of a specific branch');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'branch']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('branch');
    });

    it('should have correct tool definition for create_branch', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createBranch')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('createBranch');
      expect(tool?.description).toBe('Create a new branch');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'branch', 'ref']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('branch');
      expect(tool?.inputSchema.properties).toHaveProperty('ref');
    });

    it('should have correct tool definition for delete_branch', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'deleteBranch')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('deleteBranch');
      expect(tool?.description).toBe('Delete a branch');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'branch']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('branch');
    });

    it('should have correct tool definition for compare_branches', () => {
      const tools = createBranchTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'compareBranches')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.name).toBe('compareBranches');
      expect(tool?.description).toBe('Compare two branches');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.required).toEqual(['project_id', 'from', 'to']);
      expect(tool?.inputSchema.properties).toHaveProperty('project_id');
      expect(tool?.inputSchema.properties).toHaveProperty('from');
      expect(tool?.inputSchema.properties).toHaveProperty('to');
    });
  });
});
