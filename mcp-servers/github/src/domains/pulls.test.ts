import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createPullsClient } from './pulls.js';

function createMockOctokit() {
  return {
    rest: {
      pulls: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        merge: vi.fn(),
        update: vi.fn(),
        listFiles: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

const rawPr = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Add feature',
  body: 'Body text',
  state: 'open',
  merged: false,
  head: { ref: 'feature', sha: 'aaa' },
  base: { ref: 'main' },
  user: { login: 'octocat' },
  html_url: 'https://github.com/octocat/hello/pull/7',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  draft: false,
  ...overrides,
});

describe('PullsClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createPullsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createPullsClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists pull requests with default state "open"', async () => {
      mock.paginate.mockResolvedValue([rawPr(), rawPr({ number: 8 })]);

      const result = await client.list('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.list, {
        owner: 'octocat',
        repo: 'hello',
        state: 'open',
        head: undefined,
        base: undefined,
        per_page: 100,
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        number: 7,
        title: 'Add feature',
        body: 'Body text',
        state: 'open',
        merged: false,
        head: { ref: 'feature', sha: 'aaa' },
        base: { ref: 'main' },
        user: { login: 'octocat' },
        html_url: 'https://github.com/octocat/hello/pull/7',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        draft: false,
      });
    });

    it('passes filters and truncates to the limit', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 10 }, (_, i) => rawPr({ number: i })));

      const result = await client.list('octocat', 'hello', {
        state: 'closed',
        head: 'octocat:feature',
        base: 'develop',
        limit: 3,
      });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.list, {
        owner: 'octocat',
        repo: 'hello',
        state: 'closed',
        head: 'octocat:feature',
        base: 'develop',
        per_page: 3,
      });
    });

    it('defends against missing nested objects', async () => {
      mock.paginate.mockResolvedValue([{ number: 1, state: 'closed' }]);

      const result = await client.list('octocat', 'hello');

      expect(result[0]).toEqual({
        number: 1,
        title: '',
        body: undefined,
        state: 'closed',
        merged: undefined,
        head: { ref: '', sha: '' },
        base: { ref: '' },
        user: { login: '' },
        html_url: '',
        created_at: '',
        updated_at: '',
        draft: undefined,
      });
    });
  });

  describe('get', () => {
    it('gets a pull request by number', async () => {
      mock.rest.pulls.get.mockResolvedValue({ data: rawPr() });

      const result = await client.get('octocat', 'hello', 7);

      expect(mock.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
      });
      expect(result.number).toBe(7);
    });

    it('propagates API errors', async () => {
      mock.rest.pulls.get.mockRejectedValue(new Error('not_found'));

      await expect(client.get('octocat', 'hello', 99)).rejects.toThrow('not_found');
    });

    it('defaults state to "open" for a sparse PR response (mapPullRequest)', async () => {
      mock.rest.pulls.get.mockResolvedValue({ data: { number: 1 } });

      const result = await client.get('octocat', 'hello', 1);

      expect(result).toEqual({
        number: 1,
        title: '',
        body: undefined,
        state: 'open',
        merged: undefined,
        head: { ref: '', sha: '' },
        base: { ref: '' },
        user: { login: '' },
        html_url: '',
        created_at: '',
        updated_at: '',
        draft: undefined,
      });
    });
  });

  describe('create', () => {
    it('creates a pull request', async () => {
      mock.rest.pulls.create.mockResolvedValue({ data: rawPr({ number: 12 }) });

      const result = await client.create('octocat', 'hello', {
        title: 'New PR',
        head: 'feature',
        base: 'main',
        body: 'desc',
        draft: true,
      });

      expect(mock.rest.pulls.create).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        title: 'New PR',
        head: 'feature',
        base: 'main',
        body: 'desc',
        draft: true,
      });
      expect(result.number).toBe(12);
    });
  });

  describe('merge', () => {
    it('merges with the default merge method', async () => {
      mock.rest.pulls.merge.mockResolvedValue({
        data: { merged: true, sha: 'mergesha', message: 'Pull Request successfully merged' },
      });

      const result = await client.merge('octocat', 'hello', 7);

      expect(mock.rest.pulls.merge).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        merge_method: 'merge',
        commit_title: undefined,
      });
      expect(result).toEqual({
        merged: true,
        sha: 'mergesha',
        message: 'Pull Request successfully merged',
      });
    });

    it('passes a custom merge method and commit title, defending against missing fields', async () => {
      mock.rest.pulls.merge.mockResolvedValue({ data: {} });

      const result = await client.merge('octocat', 'hello', 7, {
        merge_method: 'squash',
        commit_title: 'Squash it',
      });

      expect(mock.rest.pulls.merge).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        merge_method: 'squash',
        commit_title: 'Squash it',
      });
      expect(result).toEqual({ merged: false, sha: '', message: '' });
    });
  });

  describe('update', () => {
    it('updates a pull request', async () => {
      mock.rest.pulls.update.mockResolvedValue({
        data: rawPr({ title: 'Updated', state: 'closed' }),
      });

      const result = await client.update('octocat', 'hello', 7, {
        title: 'Updated',
        body: 'new body',
        state: 'closed',
        base: 'develop',
      });

      expect(mock.rest.pulls.update).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        title: 'Updated',
        body: 'new body',
        state: 'closed',
        base: 'develop',
      });
      expect(result.title).toBe('Updated');
      expect(result.state).toBe('closed');
    });
  });

  describe('listFiles', () => {
    it('lists changed files with stats', async () => {
      mock.paginate.mockResolvedValue([
        {
          filename: 'src/a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -1 +1 @@',
        },
        { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0, changes: 10 },
      ]);

      const result = await client.listFiles('octocat', 'hello', 7);

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listFiles, {
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        per_page: 100,
      });
      expect(result).toEqual([
        {
          filename: 'src/a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -1 +1 @@',
        },
        {
          filename: 'src/b.ts',
          status: 'added',
          additions: 10,
          deletions: 0,
          changes: 10,
          patch: undefined,
        },
      ]);
    });

    it('truncates to the limit and defends against missing fields', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 5 }, () => ({})));

      const result = await client.listFiles('octocat', 'hello', 7, { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        filename: '',
        status: '',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      });
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.pulls.listFiles, {
        owner: 'octocat',
        repo: 'hello',
        pull_number: 7,
        per_page: 2,
      });
    });
  });
});
