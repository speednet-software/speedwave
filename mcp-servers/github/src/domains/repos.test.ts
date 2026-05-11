import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createReposClient } from './repos.js';

function createMockOctokit() {
  return {
    rest: {
      repos: {
        get: vi.fn(),
        listForAuthenticatedUser: vi.fn(),
      },
      search: {
        repos: vi.fn(),
        code: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

const rawRepo = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'hello',
  full_name: 'octocat/hello',
  owner: { login: 'octocat' },
  description: 'A repo',
  html_url: 'https://github.com/octocat/hello',
  default_branch: 'main',
  private: false,
  ...overrides,
});

describe('ReposClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createReposClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createReposClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists the authenticated user repos when no search term is given', async () => {
      mock.paginate.mockResolvedValue([rawRepo(), rawRepo({ id: 2, name: 'world' })]);

      const result = await client.list({ affiliation: 'owner' });

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        affiliation: 'owner',
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        name: 'hello',
        full_name: 'octocat/hello',
        owner: { login: 'octocat' },
        description: 'A repo',
        html_url: 'https://github.com/octocat/hello',
        default_branch: 'main',
        private: false,
      });
    });

    it('searches repositories when a search term is given', async () => {
      mock.rest.search.repos.mockResolvedValue({ data: { items: [rawRepo({ name: 'found' })] } });

      const result = await client.list({ search: 'topic:cli' });

      expect(mock.rest.search.repos).toHaveBeenCalledWith({ q: 'topic:cli', per_page: 100 });
      expect(mock.paginate).not.toHaveBeenCalled();
      expect(result[0].name).toBe('found');
    });

    it('handles a search response without items', async () => {
      mock.rest.search.repos.mockResolvedValue({ data: {} });

      const result = await client.list({ search: 'nothing' });

      expect(result).toEqual([]);
    });

    it('truncates list results to the limit', async () => {
      mock.paginate.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => rawRepo({ id: i, name: `r${i}` }))
      );

      const result = await client.list({ limit: 4 });

      expect(result).toHaveLength(4);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listForAuthenticatedUser, {
        per_page: 4,
        affiliation: undefined,
      });
    });

    it('defends against missing fields', async () => {
      mock.paginate.mockResolvedValue([{}]);

      const result = await client.list();

      expect(result[0]).toEqual({
        id: NaN,
        name: '',
        full_name: '',
        owner: { login: '' },
        description: undefined,
        html_url: '',
        default_branch: '',
        private: false,
      });
    });
  });

  describe('get', () => {
    it('gets a repository by owner/name', async () => {
      mock.rest.repos.get.mockResolvedValue({ data: rawRepo() });

      const result = await client.get('octocat', 'hello');

      expect(mock.rest.repos.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello' });
      expect(result.full_name).toBe('octocat/hello');
    });

    it('propagates API errors', async () => {
      mock.rest.repos.get.mockRejectedValue(new Error('not_found'));

      await expect(client.get('octocat', 'missing')).rejects.toThrow('not_found');
    });
  });

  describe('searchCode', () => {
    it('searches code and maps the matches', async () => {
      mock.rest.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: 'src/index.ts',
              repository: { full_name: 'octocat/hello' },
              html_url: 'https://github.com/octocat/hello/blob/main/src/index.ts',
            },
          ],
        },
      });

      const result = await client.searchCode('addEventListener');

      expect(mock.rest.search.code).toHaveBeenCalledWith({
        q: 'addEventListener',
        per_page: 100,
      });
      expect(result).toEqual([
        {
          path: 'src/index.ts',
          repository: 'octocat/hello',
          html_url: 'https://github.com/octocat/hello/blob/main/src/index.ts',
        },
      ]);
    });

    it('truncates code search results and defends against missing repository', async () => {
      mock.rest.search.code.mockResolvedValue({
        data: { items: Array.from({ length: 5 }, () => ({ path: 'a.ts' })) },
      });

      const result = await client.searchCode('foo', { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: 'a.ts', repository: '', html_url: '' });
      expect(mock.rest.search.code).toHaveBeenCalledWith({ q: 'foo', per_page: 2 });
    });

    it('handles a code search response without items', async () => {
      mock.rest.search.code.mockResolvedValue({ data: {} });

      const result = await client.searchCode('foo');

      expect(result).toEqual([]);
    });

    it('normalizes a fully sparse code search match', async () => {
      mock.rest.search.code.mockResolvedValue({ data: { items: [{}] } });

      const result = await client.searchCode('foo');

      expect(result).toEqual([{ path: '', repository: '', html_url: '' }]);
    });
  });
});
