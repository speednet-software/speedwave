/**
 * Tests for GitHub Repo Tools
 *
 * Coverage: listRepos, getRepo, searchCode (3 tools)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createRepoTools } from './repo-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listRepos: Mock;
  getRepo: Mock;
  searchCode: Mock;
};

function createMockClient(): MockClient {
  return {
    listRepos: vi.fn(),
    getRepo: vi.fn(),
    searchCode: vi.fn(),
  };
}

const NOT_CONFIGURED = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'hello-world',
    full_name: 'octocat/hello-world',
    owner: { login: 'octocat' },
    description: 'My first repo',
    html_url: 'https://github.com/octocat/hello-world',
    default_branch: 'main',
    private: false,
    ...overrides,
  };
}

describe('Repo Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  describe('unconfigured client', () => {
    it('returns 3 tools when client is null', () => {
      const tools = createRepoTools(null);
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.tool.name)).toEqual(['listRepos', 'getRepo', 'searchCode']);
    });

    it('returns error for listRepos when client is null', async () => {
      const tools = createRepoTools(null);
      const handler = tools.find((t) => t.tool.name === 'listRepos')?.handler;
      expect(handler).toBeDefined();
      expect(await handler!({})).toEqual(NOT_CONFIGURED);
    });

    it('returns error for getRepo when client is null', async () => {
      const tools = createRepoTools(null);
      const handler = tools.find((t) => t.tool.name === 'getRepo')?.handler;
      expect(await handler!({ owner: 'octocat', repo: 'hello-world' })).toEqual(NOT_CONFIGURED);
    });

    it('returns error for searchCode when client is null', async () => {
      const tools = createRepoTools(null);
      const handler = tools.find((t) => t.tool.name === 'searchCode')?.handler;
      expect(await handler!({ query: 'foo' })).toEqual(NOT_CONFIGURED);
    });
  });

  describe('tool definitions', () => {
    it('returns 3 tools when configured with correct names and annotations', () => {
      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.tool.name)).toEqual(['listRepos', 'getRepo', 'searchCode']);
      // listRepos is the primary list tool — eager-loaded
      expect(
        tools.find((t) => t.tool.name === 'listRepos')?.tool._meta?.[META_KEYS.DEFER_LOADING]
      ).toBe(false);
      expect(
        tools.find((t) => t.tool.name === 'getRepo')?.tool._meta?.[META_KEYS.DEFER_LOADING]
      ).toBe(true);
      expect(
        tools.find((t) => t.tool.name === 'searchCode')?.tool._meta?.[META_KEYS.DEFER_LOADING]
      ).toBe(true);
    });

    it('searchCode requires query, getRepo requires owner+repo, listRepos requires nothing', () => {
      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      expect(tools.find((t) => t.tool.name === 'searchCode')?.tool.inputSchema.required).toEqual([
        'query',
      ]);
      expect(tools.find((t) => t.tool.name === 'getRepo')?.tool.inputSchema.required).toEqual([
        'owner',
        'repo',
      ]);
      expect(
        tools.find((t) => t.tool.name === 'listRepos')?.tool.inputSchema.required
      ).toBeUndefined();
    });
  });

  describe('listRepos', () => {
    it('lists repos with no options', async () => {
      const repos = [
        makeRepo(),
        makeRepo({ full_name: 'octocat/other', name: 'other', private: true }),
      ];
      mockClient.listRepos.mockResolvedValue(repos);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listRepos')?.handler;
      const result = await handler!({});

      const expected = {
        repos: repos.map((r) => ({
          full_name: r.full_name,
          description: r.description,
          html_url: r.html_url,
          default_branch: r.default_branch,
          private: r.private,
        })),
        count: 2,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.listRepos).toHaveBeenCalledWith({});
    });

    it('passes search, affiliation and limit through', async () => {
      mockClient.listRepos.mockResolvedValue([makeRepo()]);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listRepos')?.handler;
      await handler!({ search: 'language:rust', affiliation: 'owner', limit: 5 });

      expect(mockClient.listRepos).toHaveBeenCalledWith({
        search: 'language:rust',
        affiliation: 'owner',
        limit: 5,
      });
    });

    it('returns an empty list when there are no repos', async () => {
      mockClient.listRepos.mockResolvedValue([]);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listRepos')?.handler;
      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ repos: [], count: 0 }, null, 2) }],
      });
    });

    it('returns error when the API call fails', async () => {
      mockClient.listRepos.mockRejectedValue(new Error('Bad credentials'));

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listRepos')?.handler;
      const result = await handler!({});

      expect(result).toMatchObject({ isError: true });
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain('Error:');
    });
  });

  describe('getRepo', () => {
    it('returns the mapped repo', async () => {
      const repo = makeRepo({ full_name: 'octocat/spoon-knife', name: 'spoon-knife' });
      mockClient.getRepo.mockResolvedValue(repo);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getRepo')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'spoon-knife' });

      const expected = {
        full_name: 'octocat/spoon-knife',
        description: repo.description,
        html_url: repo.html_url,
        default_branch: repo.default_branch,
        private: false,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.getRepo).toHaveBeenCalledWith('octocat', 'spoon-knife');
    });

    it('handles a private repo without description', async () => {
      const repo = makeRepo({ private: true, description: undefined });
      mockClient.getRepo.mockResolvedValue(repo);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getRepo')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world' });

      const expected = {
        full_name: repo.full_name,
        html_url: repo.html_url,
        default_branch: repo.default_branch,
        private: true,
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
    });

    it('returns error on 404', async () => {
      mockClient.getRepo.mockRejectedValue(new Error('Not Found'));

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getRepo')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'missing' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('searchCode', () => {
    it('searches code with just a query', async () => {
      const matches = [
        {
          path: 'src/index.ts',
          repository: 'octocat/hello-world',
          html_url: 'https://github.com/x',
        },
      ];
      mockClient.searchCode.mockResolvedValue(matches);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'searchCode')?.handler;
      const result = await handler!({ query: 'addEventListener' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ results: matches, count: 1 }, null, 2) }],
      });
      expect(mockClient.searchCode).toHaveBeenCalledWith('addEventListener', {});
    });

    it('passes owner, repo and limit as options (query stays positional)', async () => {
      mockClient.searchCode.mockResolvedValue([]);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'searchCode')?.handler;
      await handler!({ query: 'TODO', owner: 'octocat', repo: 'hello-world', limit: 10 });

      expect(mockClient.searchCode).toHaveBeenCalledWith('TODO', {
        owner: 'octocat',
        repo: 'hello-world',
        limit: 10,
      });
    });

    it('returns an empty result set', async () => {
      mockClient.searchCode.mockResolvedValue([]);

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'searchCode')?.handler;
      const result = await handler!({ query: 'zzz' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ results: [], count: 0 }, null, 2) }],
      });
    });

    it('returns error on rate limit', async () => {
      mockClient.searchCode.mockRejectedValue(new Error('API rate limit exceeded'));

      const tools = createRepoTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'searchCode')?.handler;
      const result = await handler!({ query: 'foo' });

      expect(result).toMatchObject({ isError: true });
    });
  });
});
