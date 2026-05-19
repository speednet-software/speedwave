/**
 * Commit Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createCommitTools } from './commit-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listCommits: Mock;
  listBranchCommits: Mock;
  searchCommits: Mock;
  getCommitDiff: Mock;
};

const createMockClient = (): MockClient => ({
  listCommits: vi.fn(),
  listBranchCommits: vi.fn(),
  searchCommits: vi.fn(),
  getCommitDiff: vi.fn(),
});

const rawCommit = (sha: string, message: string) => ({
  sha,
  commit: {
    message,
    author: { name: 'Octocat', email: 'octo@example.com', date: '2024-01-02T03:04:05Z' },
  },
  html_url: `https://github.com/octocat/hello-world/commit/${sha}`,
});

const summary = (sha: string, message: string) => ({
  sha,
  message,
  author: 'Octocat',
  date: '2024-01-02T03:04:05Z',
  html_url: `https://github.com/octocat/hello-world/commit/${sha}`,
});

const findHandler = (tools: ReturnType<typeof createCommitTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

describe('commit-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly the 4 expected tools', () => {
    const names = createCommitTools(null).map((t) => t.tool.name);
    expect(names).toEqual(['listCommits', 'listBranchCommits', 'searchCommits', 'getCommitDiff']);
  });

  it('marks listCommits as the eagerly-loaded tool and the rest as deferred', () => {
    const tools = createCommitTools(null);
    expect(tools.find((t) => t.tool.name === 'listCommits')!.tool._meta).toEqual({
      deferLoading: false,
    });
    expect(tools.find((t) => t.tool.name === 'getCommitDiff')!.tool._meta).toEqual({
      deferLoading: true,
    });
  });

  describe('unconfigured client', () => {
    it.each(['listCommits', 'listBranchCommits', 'searchCommits', 'getCommitDiff'])(
      'returns not-configured error for %s',
      async (name) => {
        const handler = findHandler(createCommitTools(null), name);
        const result = await handler({
          owner: 'octocat',
          repo: 'hello-world',
          branch: 'main',
          ref: 'x',
          query: 'q',
        });
        expect(result).toEqual(notConfigured);
      }
    );
  });

  describe('listCommits', () => {
    it('returns mapped commit summaries with count for minimal input', async () => {
      const client = createMockClient();
      client.listCommits.mockResolvedValue([
        rawCommit('aaa111', 'first'),
        rawCommit('bbb222', 'second'),
      ]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listCommits'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { commits: [summary('aaa111', 'first'), summary('bbb222', 'second')], count: 2 },
              null,
              2
            ),
          },
        ],
      });
      expect(client.listCommits).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('spreads all optional filters to the client', async () => {
      const client = createMockClient();
      client.listCommits.mockResolvedValue([]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listCommits'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        sha: 'main',
        path: 'src/index.ts',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
        limit: 50,
      });

      expect(client.listCommits).toHaveBeenCalledWith('octocat', 'hello-world', {
        sha: 'main',
        path: 'src/index.ts',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
        limit: 50,
      });
    });

    it('returns empty list with count 0 when there are no commits', async () => {
      const client = createMockClient();
      client.listCommits.mockResolvedValue([]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listCommits'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ commits: [], count: 0 }, null, 2) }],
      });
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.listCommits.mockRejectedValue(new Error('boom'));
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listCommits'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({ content: [{ type: 'text', text: 'Error: boom' }], isError: true });
    });

    it('maps 404 errors via the client formatter', async () => {
      const client = createMockClient();
      client.listCommits.mockRejectedValue({ status: 404, message: 'Not Found' });
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listCommits'
      );

      const result = await handler({ owner: 'octocat', repo: 'missing' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Resource not found in GitHub. Check the owner/repo and that your token has access.',
          },
        ],
        isError: true,
      });
    });
  });

  describe('listBranchCommits', () => {
    it('passes the branch and a limit option to the client', async () => {
      const client = createMockClient();
      client.listBranchCommits.mockResolvedValue([rawCommit('ccc333', 'on branch')]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listBranchCommits'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        branch: 'feature/login',
        limit: 5,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ commits: [summary('ccc333', 'on branch')], count: 1 }, null, 2),
          },
        ],
      });
      expect(client.listBranchCommits).toHaveBeenCalledWith(
        'octocat',
        'hello-world',
        'feature/login',
        { limit: 5 }
      );
    });

    it('passes an undefined limit when omitted', async () => {
      const client = createMockClient();
      client.listBranchCommits.mockResolvedValue([]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'listBranchCommits'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', branch: 'main' });

      expect(client.listBranchCommits).toHaveBeenCalledWith('octocat', 'hello-world', 'main', {
        limit: undefined,
      });
    });
  });

  describe('searchCommits', () => {
    it('passes only the query when no scope is given', async () => {
      const client = createMockClient();
      client.searchCommits.mockResolvedValue([rawCommit('ddd444', 'matched')]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'searchCommits'
      );

      const result = await handler({ query: 'fix parser' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ commits: [summary('ddd444', 'matched')], count: 1 }, null, 2),
          },
        ],
      });
      expect(client.searchCommits).toHaveBeenCalledWith('fix parser', {});
    });

    it('forwards owner/repo/limit scoping options', async () => {
      const client = createMockClient();
      client.searchCommits.mockResolvedValue([]);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'searchCommits'
      );

      await handler({ query: 'release', owner: 'octocat', repo: 'hello-world', limit: 10 });

      expect(client.searchCommits).toHaveBeenCalledWith('release', {
        owner: 'octocat',
        repo: 'hello-world',
        limit: 10,
      });
    });

    it('surfaces 403 permission errors from the client', async () => {
      const client = createMockClient();
      client.searchCommits.mockRejectedValue({ status: 403, response: { headers: {} } });
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'searchCommits'
      );

      const result = await handler({ query: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });
  });

  describe('getCommitDiff', () => {
    it('returns the raw diff string via textResult', async () => {
      const client = createMockClient();
      const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
      client.getCommitDiff.mockResolvedValue(diff);
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'getCommitDiff'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', ref: 'abc123' });

      expect(result).toEqual({ content: [{ type: 'text', text: diff }] });
      expect(result.isError).toBeUndefined();
      expect(client.getCommitDiff).toHaveBeenCalledWith('octocat', 'hello-world', 'abc123');
    });

    it('returns an empty-text result for an empty diff', async () => {
      const client = createMockClient();
      client.getCommitDiff.mockResolvedValue('');
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'getCommitDiff'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', ref: 'main' });

      expect(result).toEqual({ content: [{ type: 'text', text: '' }] });
    });

    it('returns an error result when the diff fetch fails', async () => {
      const client = createMockClient();
      client.getCommitDiff.mockRejectedValue(new Error('network down'));
      const handler = findHandler(
        createCommitTools(client as unknown as GitHubClient),
        'getCommitDiff'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', ref: 'main' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network down' }],
        isError: true,
      });
    });
  });
});
