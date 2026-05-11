import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createCommitsClient } from './commits.js';

function createMockOctokit() {
  return {
    rest: {
      repos: {
        listCommits: vi.fn(),
        getCommit: vi.fn(),
      },
      search: {
        commits: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

const rawCommit = (overrides: Record<string, unknown> = {}) => ({
  sha: 'abc',
  commit: {
    message: 'feat: add x',
    author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
  },
  html_url: 'https://github.com/octocat/hello/commit/abc',
  ...overrides,
});

const mappedCommit = (sha = 'abc') => ({
  sha,
  commit: {
    message: 'feat: add x',
    author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
  },
  html_url: 'https://github.com/octocat/hello/commit/abc',
});

describe('CommitsClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createCommitsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createCommitsClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists commits with no filters', async () => {
      mock.paginate.mockResolvedValue([rawCommit(), rawCommit({ sha: 'def' })]);

      const result = await client.list('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listCommits, {
        owner: 'octocat',
        repo: 'hello',
        sha: undefined,
        path: undefined,
        author: undefined,
        since: undefined,
        until: undefined,
        per_page: 100,
      });
      expect(result).toEqual([mappedCommit('abc'), mappedCommit('def')]);
    });

    it('passes all filters and truncates to the limit', async () => {
      mock.paginate.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => rawCommit({ sha: `c${i}` }))
      );

      const result = await client.list('octocat', 'hello', {
        sha: 'main',
        path: 'src/index.ts',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
        limit: 3,
      });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listCommits, {
        owner: 'octocat',
        repo: 'hello',
        sha: 'main',
        path: 'src/index.ts',
        author: 'octocat',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
        per_page: 3,
      });
    });

    it('defends against missing nested objects', async () => {
      mock.paginate.mockResolvedValue([{}]);

      const result = await client.list('octocat', 'hello');

      expect(result[0]).toEqual({
        sha: '',
        commit: { message: '', author: { name: '', email: '', date: '' } },
        html_url: '',
      });
    });
  });

  describe('get', () => {
    it('gets a commit by ref', async () => {
      mock.rest.repos.getCommit.mockResolvedValue({ data: rawCommit() });

      const result = await client.get('octocat', 'hello', 'abc');

      expect(mock.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'abc',
      });
      expect(result).toEqual(mappedCommit('abc'));
    });

    it('propagates API errors', async () => {
      mock.rest.repos.getCommit.mockRejectedValue(new Error('not_found'));

      await expect(client.get('octocat', 'hello', 'missing')).rejects.toThrow('not_found');
    });
  });

  describe('search', () => {
    it('searches commits and maps the matches', async () => {
      mock.rest.search.commits.mockResolvedValue({ data: { items: [rawCommit()] } });

      const result = await client.search('repo:octocat/hello fix');

      expect(mock.rest.search.commits).toHaveBeenCalledWith({
        q: 'repo:octocat/hello fix',
        per_page: 100,
      });
      expect(result).toEqual([mappedCommit('abc')]);
    });

    it('truncates results to the limit', async () => {
      mock.rest.search.commits.mockResolvedValue({
        data: { items: Array.from({ length: 5 }, () => rawCommit()) },
      });

      const result = await client.search('fix', { limit: 2 });

      expect(result).toHaveLength(2);
      expect(mock.rest.search.commits).toHaveBeenCalledWith({ q: 'fix', per_page: 2 });
    });

    it('handles a search response without items', async () => {
      mock.rest.search.commits.mockResolvedValue({ data: {} });

      const result = await client.search('nothing');

      expect(result).toEqual([]);
    });
  });
});
