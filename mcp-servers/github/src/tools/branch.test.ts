/**
 * Tests for GitHub Branch Tools
 *
 * Coverage: listBranches, getBranch, createBranch, deleteBranch, compareBranches (5 tools)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createBranchTools } from './branch-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listBranches: Mock;
  getBranch: Mock;
  createBranch: Mock;
  deleteBranch: Mock;
  compareBranches: Mock;
};

function createMockClient(): MockClient {
  return {
    listBranches: vi.fn(),
    getBranch: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    compareBranches: vi.fn(),
  };
}

const NOT_CONFIGURED = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

const ALL_TOOL_NAMES = [
  'listBranches',
  'getBranch',
  'createBranch',
  'deleteBranch',
  'compareBranches',
];

function makeBranch(overrides: Record<string, unknown> = {}) {
  return { name: 'main', commit: { sha: 'abc123' }, protected: true, ...overrides };
}

function makeCommit(overrides: Record<string, unknown> = {}) {
  return {
    sha: 'abc123',
    commit: {
      message: 'A commit',
      author: { name: 'Octo', email: 'o@x', date: '2024-01-01T00:00:00Z' },
    },
    html_url: 'https://github.com/octocat/hello-world/commit/abc123',
    ...overrides,
  };
}

describe('Branch Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  describe('unconfigured client', () => {
    it('returns 5 tools when client is null', () => {
      const tools = createBranchTools(null);
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
    });

    it.each([
      ['listBranches', { owner: 'o', repo: 'r' }],
      ['getBranch', { owner: 'o', repo: 'r', branch: 'main' }],
      ['createBranch', { owner: 'o', repo: 'r', branch: 'feature/x' }],
      ['deleteBranch', { owner: 'o', repo: 'r', branch: 'feature/x' }],
      ['compareBranches', { owner: 'o', repo: 'r', base: 'main', head: 'dev' }],
    ])('returns error for %s when client is null', async (name, args) => {
      const tools = createBranchTools(null);
      const handler = tools.find((t) => t.tool.name === name)?.handler;
      expect(handler).toBeDefined();
      expect(await handler!(args)).toEqual(NOT_CONFIGURED);
    });
  });

  describe('tool definitions', () => {
    it('returns 5 tools, listBranches is eager-loaded', () => {
      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
      expect(
        tools.find((t) => t.tool.name === 'listBranches')?.tool._meta?.[META_KEYS.DEFER_LOADING]
      ).toBe(false);
      for (const name of ALL_TOOL_NAMES.filter((n) => n !== 'listBranches')) {
        expect(tools.find((t) => t.tool.name === name)?.tool._meta?.[META_KEYS.DEFER_LOADING]).toBe(
          true
        );
      }
    });

    it('deleteBranch is destructive, createBranch is a write, compareBranches is read-only', () => {
      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      expect(tools.find((t) => t.tool.name === 'deleteBranch')?.tool.annotations).toMatchObject({
        destructiveHint: true,
      });
      expect(tools.find((t) => t.tool.name === 'createBranch')?.tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(tools.find((t) => t.tool.name === 'compareBranches')?.tool.annotations).toMatchObject({
        readOnlyHint: true,
      });
    });

    it('required fields are correct', () => {
      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      expect(tools.find((t) => t.tool.name === 'listBranches')?.tool.inputSchema.required).toEqual([
        'owner',
        'repo',
      ]);
      expect(tools.find((t) => t.tool.name === 'createBranch')?.tool.inputSchema.required).toEqual([
        'owner',
        'repo',
        'branch',
      ]);
      expect(
        tools.find((t) => t.tool.name === 'compareBranches')?.tool.inputSchema.required
      ).toEqual(['owner', 'repo', 'base', 'head']);
    });
  });

  describe('listBranches', () => {
    it('maps branches and counts them', async () => {
      const branches = [
        makeBranch(),
        makeBranch({ name: 'dev', commit: { sha: 'def456' }, protected: false }),
      ];
      mockClient.listBranches.mockResolvedValue(branches);

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world' });

      const expected = {
        branches: [
          { name: 'main', sha: 'abc123', protected: true },
          { name: 'dev', sha: 'def456', protected: false },
        ],
        count: 2,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.listBranches).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('forwards limit', async () => {
      mockClient.listBranches.mockResolvedValue([]);

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;
      await handler!({ owner: 'o', repo: 'r', limit: 50 });

      expect(mockClient.listBranches).toHaveBeenCalledWith('o', 'r', { limit: 50 });
    });

    it('returns an empty branch list', async () => {
      mockClient.listBranches.mockResolvedValue([]);

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ branches: [], count: 0 }, null, 2) }],
      });
    });

    it('returns error on failure', async () => {
      mockClient.listBranches.mockRejectedValue(new Error('Not Found'));

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listBranches')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('getBranch', () => {
    it('returns the mapped branch', async () => {
      mockClient.getBranch.mockResolvedValue(
        makeBranch({ name: 'develop', commit: { sha: 'xyz789' }, protected: false })
      );

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', branch: 'develop' });

      const expected = { name: 'develop', sha: 'xyz789', protected: false };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.getBranch).toHaveBeenCalledWith('octocat', 'hello-world', 'develop');
    });

    it('returns error on 404', async () => {
      mockClient.getBranch.mockRejectedValue(new Error('Branch not found'));

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getBranch')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', branch: 'missing' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('createBranch', () => {
    it('creates a branch from another branch', async () => {
      mockClient.createBranch.mockResolvedValue(
        makeBranch({ name: 'feature/auth', commit: { sha: 's1' }, protected: false })
      );

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'feature/auth',
        from_branch: 'main',
      });

      const expected = { name: 'feature/auth', sha: 's1', protected: false };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.createBranch).toHaveBeenCalledWith('octocat', 'hello-world', {
        branch: 'feature/auth',
        from_branch: 'main',
      });
    });

    it('creates a branch from a SHA', async () => {
      mockClient.createBranch.mockResolvedValue(
        makeBranch({ name: 'hotfix/bug', commit: { sha: 'abc123def456' }, protected: false })
      );

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;
      await handler!({ owner: 'o', repo: 'r', branch: 'hotfix/bug', from_sha: 'abc123def456' });

      expect(mockClient.createBranch).toHaveBeenCalledWith('o', 'r', {
        branch: 'hotfix/bug',
        from_sha: 'abc123def456',
      });
    });

    it('passes only the branch when neither source is given (client validates)', async () => {
      mockClient.createBranch.mockRejectedValue(
        new Error('Missing required parameter: from_sha or from_branch')
      );

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', branch: 'feature/x' });

      expect(mockClient.createBranch).toHaveBeenCalledWith('o', 'r', { branch: 'feature/x' });
      expect(result).toMatchObject({ isError: true });
    });

    it('returns error when the branch already exists', async () => {
      mockClient.createBranch.mockRejectedValue(new Error('Reference already exists'));

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createBranch')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', branch: 'main', from_branch: 'main' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('deleteBranch', () => {
    it('deletes a branch and returns the deletion result', async () => {
      mockClient.deleteBranch.mockResolvedValue({ deleted: true, branch: 'feature/old' });

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'feature/old',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: JSON.stringify({ deleted: true, branch: 'feature/old' }, null, 2) },
        ],
      });
      expect(mockClient.deleteBranch).toHaveBeenCalledWith('octocat', 'hello-world', 'feature/old');
    });

    it('returns error when deleting a protected branch', async () => {
      mockClient.deleteBranch.mockRejectedValue(new Error('Branch is protected'));

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'deleteBranch')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', branch: 'main' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('compareBranches', () => {
    it('returns the comparison summary with mapped commits', async () => {
      const cmp = {
        ahead_by: 2,
        behind_by: 1,
        total_commits: 2,
        status: 'ahead',
        commits: [makeCommit(), makeCommit({ sha: 'def456', commit: { message: 'Second' } })],
      };
      mockClient.compareBranches.mockResolvedValue(cmp);

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        base: 'main',
        head: 'develop',
      });

      const expected = {
        ahead_by: 2,
        behind_by: 1,
        total_commits: 2,
        status: 'ahead',
        commits: [
          { sha: 'abc123', message: 'A commit' },
          { sha: 'def456', message: 'Second' },
        ],
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.compareBranches).toHaveBeenCalledWith(
        'octocat',
        'hello-world',
        'main',
        'develop'
      );
    });

    it('handles an identical comparison with no commits', async () => {
      const cmp = { ahead_by: 0, behind_by: 0, total_commits: 0, status: 'identical', commits: [] };
      mockClient.compareBranches.mockResolvedValue(cmp);

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', base: 'main', head: 'main' });

      const expected = {
        ahead_by: 0,
        behind_by: 0,
        total_commits: 0,
        status: 'identical',
        commits: [],
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
    });

    it('returns error on failure', async () => {
      mockClient.compareBranches.mockRejectedValue(new Error('Not Found'));

      const tools = createBranchTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'compareBranches')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', base: 'main', head: 'missing' });

      expect(result).toMatchObject({ isError: true });
    });
  });
});
