import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createBranchesClient } from './branches.js';

function createMockOctokit() {
  return {
    rest: {
      repos: {
        listBranches: vi.fn(),
        getBranch: vi.fn(),
        compareCommitsWithBasehead: vi.fn(),
      },
      git: {
        createRef: vi.fn(),
        deleteRef: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

describe('BranchesClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createBranchesClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createBranchesClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists branches and maps them', async () => {
      mock.paginate.mockResolvedValue([
        { name: 'main', commit: { sha: 'abc' }, protected: true },
        { name: 'dev', commit: { sha: 'def' }, protected: false },
      ]);

      const result = await client.list('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listBranches, {
        owner: 'octocat',
        repo: 'hello',
        per_page: 100,
      });
      expect(result).toEqual([
        { name: 'main', commit: { sha: 'abc' }, protected: true },
        { name: 'dev', commit: { sha: 'def' }, protected: false },
      ]);
    });

    it('truncates to the limit and defends against missing fields', async () => {
      mock.paginate.mockResolvedValue(Array.from({ length: 10 }, () => ({})));

      const result = await client.list('octocat', 'hello', { limit: 2 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: '', commit: { sha: '' }, protected: false });
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.repos.listBranches, {
        owner: 'octocat',
        repo: 'hello',
        per_page: 2,
      });
    });
  });

  describe('get', () => {
    it('gets a branch by name', async () => {
      mock.rest.repos.getBranch.mockResolvedValue({
        data: { name: 'main', commit: { sha: 'abc' }, protected: true },
      });

      const result = await client.get('octocat', 'hello', 'main');

      expect(mock.rest.repos.getBranch).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        branch: 'main',
      });
      expect(result).toEqual({ name: 'main', commit: { sha: 'abc' }, protected: true });
    });

    it('propagates API errors', async () => {
      mock.rest.repos.getBranch.mockRejectedValue(new Error('not_found'));

      await expect(client.get('octocat', 'hello', 'missing')).rejects.toThrow('not_found');
    });
  });

  describe('create', () => {
    it('creates a branch ref pointing at a SHA', async () => {
      mock.rest.git.createRef.mockResolvedValue({
        data: { ref: 'refs/heads/feature', object: { sha: 'abc' } },
      });

      const result = await client.create('octocat', 'hello', 'feature', 'abc');

      expect(mock.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'refs/heads/feature',
        sha: 'abc',
      });
      expect(result).toEqual({ ref: 'refs/heads/feature', sha: 'abc' });
    });

    it('defends against a missing object field', async () => {
      mock.rest.git.createRef.mockResolvedValue({ data: { ref: 'refs/heads/feature' } });

      const result = await client.create('octocat', 'hello', 'feature', 'abc');

      expect(result).toEqual({ ref: 'refs/heads/feature', sha: '' });
    });

    it('defends against a completely empty createRef response', async () => {
      mock.rest.git.createRef.mockResolvedValue({ data: {} });

      const result = await client.create('octocat', 'hello', 'feature', 'abc');

      expect(result).toEqual({ ref: '', sha: '' });
    });
  });

  describe('delete', () => {
    it('deletes a branch ref', async () => {
      mock.rest.git.deleteRef.mockResolvedValue({});

      await client.delete('octocat', 'hello', 'feature');

      expect(mock.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'heads/feature',
      });
    });
  });

  describe('compare', () => {
    it('compares two refs and maps the result', async () => {
      mock.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
        data: {
          ahead_by: 2,
          behind_by: 1,
          total_commits: 3,
          status: 'diverged',
          commits: [
            {
              sha: 'c1',
              commit: {
                message: 'first',
                author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
              },
              html_url: 'https://github.com/octocat/hello/commit/c1',
            },
          ],
        },
      });

      const result = await client.compare('octocat', 'hello', 'main', 'feature');

      expect(mock.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        basehead: 'main...feature',
      });
      expect(result).toEqual({
        ahead_by: 2,
        behind_by: 1,
        total_commits: 3,
        status: 'diverged',
        commits: [
          {
            sha: 'c1',
            commit: {
              message: 'first',
              author: { name: 'Dev', email: 'dev@example.com', date: '2024-01-01T00:00:00Z' },
            },
            html_url: 'https://github.com/octocat/hello/commit/c1',
          },
        ],
      });
    });

    it('defends against missing fields and a non-array commits list', async () => {
      mock.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
        data: { commits: 'not-an-array' },
      });

      const result = await client.compare('octocat', 'hello', 'main', 'feature');

      expect(result).toEqual({
        ahead_by: 0,
        behind_by: 0,
        total_commits: 0,
        status: '',
        commits: [],
      });
    });

    it('normalizes sparse commit entries in the comparison (mapCommit defaults)', async () => {
      mock.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { commits: [{}] } });

      const result = await client.compare('octocat', 'hello', 'main', 'feature');

      expect(result.commits).toEqual([
        {
          sha: '',
          commit: { message: '', author: { name: '', email: '', date: '' } },
          html_url: '',
        },
      ]);
    });
  });
});
