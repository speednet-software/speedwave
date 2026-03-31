/**
 * Commit Tools Tests - 4 tools for GitLab commit operations
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createCommitTools } from './commit-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listBranchCommits: Mock;
  listCommits: Mock;
  searchCommits: Mock;
  getCommitDiff: Mock;
};

describe('commit-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      listBranchCommits: vi.fn(),
      listCommits: vi.fn(),
      searchCommits: vi.fn(),
      getCommitDiff: vi.fn(),
    };
    vi.clearAllMocks();
  });

  describe('listBranchCommits', () => {
    it('should list commits on a branch successfully', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Fix bug in authentication',
          message: 'Fix bug in authentication module',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'def456',
          short_id: 'def456',
          title: 'Add new feature',
          message: 'Add new feature for users',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockClient.listBranchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listBranchCommits');
      const result = await tool!.handler({ project_id: 123, branch: 'main' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listBranchCommits).toHaveBeenCalledWith(123, 'main', undefined);
    });

    it('should list commits with custom limit', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Commit 1',
          message: 'Commit 1 message',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockClient.listBranchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listBranchCommits');
      const result = await tool!.handler({
        project_id: 'group/project',
        branch: 'develop',
        limit: 10,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listBranchCommits).toHaveBeenCalledWith('group/project', 'develop', 10);
    });

    it('should handle errors when listing branch commits', async () => {
      mockClient.listBranchCommits.mockRejectedValue(new Error('Branch not found'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listBranchCommits');
      const result = await tool!.handler({ project_id: 123, branch: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should handle API errors', async () => {
      mockClient.listBranchCommits.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listBranchCommits');
      const result = await tool!.handler({ project_id: 123, branch: 'main' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Authentication failed. Check your GitLab token.')}`,
          },
        ],
        isError: true,
      });
    });
  });

  describe('listCommits', () => {
    it('should list commits successfully with default options', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Initial commit',
          message: 'Initial commit',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith(123, {});
    });

    it('should list commits with ref filter', async () => {
      const mockCommits = [
        {
          id: 'def456',
          short_id: 'def456',
          title: 'Feature commit',
          message: 'Feature commit',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 'group/project', ref: 'feature/branch' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith('group/project', {
        ref: 'feature/branch',
      });
    });

    it('should list commits with date filters', async () => {
      const mockCommits = [
        {
          id: 'ghi789',
          short_id: 'ghi789',
          title: 'Commit in range',
          message: 'Commit in range',
          author_name: 'Bob Smith',
          author_email: 'bob@example.com',
          created_at: '2024-01-15T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({
        project_id: 123,
        since: '2024-01-01T00:00:00Z',
        until: '2024-01-31T23:59:59Z',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith(123, {
        since: '2024-01-01T00:00:00Z',
        until: '2024-01-31T23:59:59Z',
      });
    });

    it('should list commits with path filter', async () => {
      const mockCommits = [
        {
          id: 'jkl012',
          short_id: 'jkl012',
          title: 'Update README',
          message: 'Update README.md',
          author_name: 'Alice Johnson',
          author_email: 'alice@example.com',
          created_at: '2024-01-10T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 123, path: 'README.md' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith(123, { path: 'README.md' });
    });

    it('should list commits with limit', async () => {
      const mockCommits = [
        {
          id: 'mno345',
          short_id: 'mno345',
          title: 'Commit 1',
          message: 'Commit 1',
          author_name: 'Developer',
          author_email: 'dev@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 123, limit: 5 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith(123, { limit: 5 });
    });

    it('should list commits with all filters', async () => {
      const mockCommits = [
        {
          id: 'pqr678',
          short_id: 'pqr678',
          title: 'Complex query result',
          message: 'Complex query result',
          author_name: 'Developer',
          author_email: 'dev@example.com',
          created_at: '2024-01-20T00:00:00Z',
        },
      ];

      mockClient.listCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({
        project_id: 'group/project',
        ref: 'develop',
        since: '2024-01-01T00:00:00Z',
        until: '2024-01-31T23:59:59Z',
        path: 'src/app.ts',
        limit: 10,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.listCommits).toHaveBeenCalledWith('group/project', {
        ref: 'develop',
        since: '2024-01-01T00:00:00Z',
        until: '2024-01-31T23:59:59Z',
        path: 'src/app.ts',
        limit: 10,
      });
    });

    it('should handle errors when listing commits', async () => {
      mockClient.listCommits.mockRejectedValue(new Error('Project not found'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should handle network errors', async () => {
      mockClient.listCommits.mockRejectedValue(new Error('Network timeout'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });
  });

  describe('searchCommits', () => {
    it('should search commits successfully', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Fix bug in authentication',
          message: 'Fix bug in authentication module',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'def456',
          short_id: 'def456',
          title: 'Fix typo in documentation',
          message: 'Fix typo in README',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockClient.searchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'fix' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.searchCommits).toHaveBeenCalledWith(123, 'fix', {});
    });

    it('should search commits with ref filter', async () => {
      const mockCommits = [
        {
          id: 'ghi789',
          short_id: 'ghi789',
          title: 'Feature implementation',
          message: 'Feature implementation',
          author_name: 'Bob Smith',
          author_email: 'bob@example.com',
          created_at: '2024-01-03T00:00:00Z',
        },
      ];

      mockClient.searchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({
        project_id: 'group/project',
        query: 'feature',
        ref: 'develop',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.searchCommits).toHaveBeenCalledWith('group/project', 'feature', {
        ref: 'develop',
      });
    });

    it('should search commits with limit', async () => {
      const mockCommits = [
        {
          id: 'jkl012',
          short_id: 'jkl012',
          title: 'Update dependencies',
          message: 'Update dependencies',
          author_name: 'Developer',
          author_email: 'dev@example.com',
          created_at: '2024-01-04T00:00:00Z',
        },
      ];

      mockClient.searchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'update', limit: 5 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.searchCommits).toHaveBeenCalledWith(123, 'update', { limit: 5 });
    });

    it('should search commits with all options', async () => {
      const mockCommits = [
        {
          id: 'mno345',
          short_id: 'mno345',
          title: 'Refactor code',
          message: 'Refactor code for better maintainability',
          author_name: 'Alice Johnson',
          author_email: 'alice@example.com',
          created_at: '2024-01-05T00:00:00Z',
        },
      ];

      mockClient.searchCommits.mockResolvedValue(mockCommits);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({
        project_id: 'group/project',
        query: 'refactor',
        ref: 'main',
        limit: 10,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
      expect(mockClient.searchCommits).toHaveBeenCalledWith('group/project', 'refactor', {
        ref: 'main',
        limit: 10,
      });
    });

    it('should handle empty search results', async () => {
      mockClient.searchCommits.mockResolvedValue([]);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
      expect(mockClient.searchCommits).toHaveBeenCalledWith(123, 'nonexistent', {});
    });

    it('should handle errors when searching commits', async () => {
      mockClient.searchCommits.mockRejectedValue(new Error('Search failed'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'test' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Search failed' }],
        isError: true,
      });
    });

    it('should handle permission errors', async () => {
      mockClient.searchCommits.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'test' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });
  });

  describe('getCommitDiff', () => {
    it('should get commit diff successfully', async () => {
      const mockDiff = [
        {
          old_path: 'src/app.ts',
          new_path: 'src/app.ts',
          diff: '@@ -1,5 +1,5 @@\n-const x = 1;\n+const x = 2;',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
        {
          old_path: 'README.md',
          new_path: 'README.md',
          diff: '@@ -10,3 +10,4 @@\n ## Installation\n+Run npm install',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ];

      mockClient.getCommitDiff.mockResolvedValue(mockDiff);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'abc123def456' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiff, null, 2) }],
      });
      expect(mockClient.getCommitDiff).toHaveBeenCalledWith(123, 'abc123def456');
    });

    it('should get commit diff with project path', async () => {
      const mockDiff = [
        {
          old_path: 'package.json',
          new_path: 'package.json',
          diff: '@@ -5,1 +5,1 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ];

      mockClient.getCommitDiff.mockResolvedValue(mockDiff);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({
        project_id: 'group/project',
        commit_sha: 'def456abc789',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiff, null, 2) }],
      });
      expect(mockClient.getCommitDiff).toHaveBeenCalledWith('group/project', 'def456abc789');
    });

    it('should handle empty diff', async () => {
      mockClient.getCommitDiff.mockResolvedValue([]);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'nochanges' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
      expect(mockClient.getCommitDiff).toHaveBeenCalledWith(123, 'nochanges');
    });

    it('should handle new file in diff', async () => {
      const mockDiff = [
        {
          old_path: 'new-file.ts',
          new_path: 'new-file.ts',
          diff: '@@ -0,0 +1,10 @@\n+export const newFunction = () => {',
          new_file: true,
          renamed_file: false,
          deleted_file: false,
        },
      ];

      mockClient.getCommitDiff.mockResolvedValue(mockDiff);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'newfile123' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiff, null, 2) }],
      });
    });

    it('should handle deleted file in diff', async () => {
      const mockDiff = [
        {
          old_path: 'deleted-file.ts',
          new_path: 'deleted-file.ts',
          diff: '@@ -1,10 +0,0 @@\n-export const oldFunction = () => {',
          new_file: false,
          renamed_file: false,
          deleted_file: true,
        },
      ];

      mockClient.getCommitDiff.mockResolvedValue(mockDiff);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'deletefile456' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiff, null, 2) }],
      });
    });

    it('should handle renamed file in diff', async () => {
      const mockDiff = [
        {
          old_path: 'old-name.ts',
          new_path: 'new-name.ts',
          diff: '',
          new_file: false,
          renamed_file: true,
          deleted_file: false,
        },
      ];

      mockClient.getCommitDiff.mockResolvedValue(mockDiff);

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'rename789' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiff, null, 2) }],
      });
    });

    it('should handle errors when getting commit diff', async () => {
      mockClient.getCommitDiff.mockRejectedValue(new Error('Commit not found'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'nonexistent' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should handle invalid SHA errors', async () => {
      mockClient.getCommitDiff.mockRejectedValue(new Error('Invalid commit SHA'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'invalid' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Invalid commit SHA' }],
        isError: true,
      });
    });

    it('should handle API errors', async () => {
      mockClient.getCommitDiff.mockRejectedValue(new Error('500 Internal Server Error'));

      const tools = createCommitTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'abc123' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: 500 Internal Server Error' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('should return error for list_branch_commits when client is null', async () => {
      const tools = createCommitTools(null);
      const tool = tools.find((t) => t.tool.name === 'listBranchCommits');
      const result = await tool!.handler({ project_id: 123, branch: 'main' });

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

    it('should return error for list_commits when client is null', async () => {
      const tools = createCommitTools(null);
      const tool = tools.find((t) => t.tool.name === 'listCommits');
      const result = await tool!.handler({ project_id: 123 });

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

    it('should return error for search_commits when client is null', async () => {
      const tools = createCommitTools(null);
      const tool = tools.find((t) => t.tool.name === 'searchCommits');
      const result = await tool!.handler({ project_id: 123, query: 'test' });

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

    it('should return error for get_commit_diff when client is null', async () => {
      const tools = createCommitTools(null);
      const tool = tools.find((t) => t.tool.name === 'getCommitDiff');
      const result = await tool!.handler({ project_id: 123, commit_sha: 'abc123' });

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
  });
});
