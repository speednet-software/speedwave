import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCommitsClient } from './commits.js';

// Create inline mock
function createMockGitlab() {
  return {
    Commits: {
      all: vi.fn(),
      showDiff: vi.fn(),
    },
  };
}

describe('CommitsClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createCommitsClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createCommitsClient(mockGitlab as any);
  });

  describe('listBranch', () => {
    it('should list commits for a branch with default limit', async () => {
      const mockCommits = [
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
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranch('project-1', 'main');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('commit1');
      expect(result[0].title).toBe('First commit');
      expect(result[1].id).toBe('commit2');
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: 'main',
        perPage: 20,
      });
    });

    it('should respect custom limit', async () => {
      const mockCommits = Array.from({ length: 50 }, (_, i) => ({
        id: `commit-${i}`,
        short_id: `commit-${i}`,
        title: `Commit ${i}`,
        message: `Commit message ${i}`,
        author_name: 'Author',
        author_email: 'author@example.com',
        created_at: '2024-01-01T00:00:00Z',
      }));

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranch('project-1', 'develop', 5);

      expect(result).toHaveLength(5);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: 'develop',
        perPage: 5,
      });
    });

    it('should map camelCase properties to snake_case', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          shortId: 'commit1',
          title: 'Test commit',
          message: 'Test commit message',
          authorName: 'John Doe',
          authorEmail: 'john@example.com',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranch('project-1', 'main');

      expect(result[0].short_id).toBe('commit1');
      expect(result[0].author_name).toBe('John Doe');
      expect(result[0].author_email).toBe('john@example.com');
      expect(result[0].created_at).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('getDiff', () => {
    it('should get diff for a commit', async () => {
      const mockDiff = [
        {
          old_path: 'file1.txt',
          new_path: 'file1.txt',
          diff: '@@ -1 +1 @@\n-old\n+new',
        },
      ];

      mockGitlab.Commits.showDiff.mockResolvedValue(mockDiff);

      const result = await client.getDiff('project-1', 'commit-sha-123');

      expect(result).toEqual(mockDiff);
      expect(mockGitlab.Commits.showDiff).toHaveBeenCalledWith('project-1', 'commit-sha-123');
    });

    it('should handle empty diff', async () => {
      mockGitlab.Commits.showDiff.mockResolvedValue([]);

      const result = await client.getDiff('project-1', 'commit-sha-456');

      expect(result).toEqual([]);
    });
  });

  describe('list', () => {
    it('should list commits with default options', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          short_id: 'commit1',
          title: 'First commit',
          message: 'First commit message',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.list('project-1');

      expect(result).toHaveLength(1);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: undefined,
        since: undefined,
        until: undefined,
        path: undefined,
        perPage: 20,
      });
    });

    it('should filter commits by ref', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          short_id: 'commit1',
          title: 'Feature commit',
          message: 'Feature commit message',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.list('project-1', { ref: 'feature/branch' });

      expect(result).toHaveLength(1);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: 'feature/branch',
        since: undefined,
        until: undefined,
        path: undefined,
        perPage: 20,
      });
    });

    it('should filter commits by date range', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          short_id: 'commit1',
          title: 'Commit in range',
          message: 'Commit in range',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-15T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.list('project-1', {
        since: '2024-01-01',
        until: '2024-01-31',
      });

      expect(result).toHaveLength(1);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: undefined,
        since: '2024-01-01',
        until: '2024-01-31',
        path: undefined,
        perPage: 20,
      });
    });

    it('should filter commits by file path', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          short_id: 'commit1',
          title: 'Modified src/app.ts',
          message: 'Modified src/app.ts',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.list('project-1', { path: 'src/app.ts' });

      expect(result).toHaveLength(1);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: undefined,
        since: undefined,
        until: undefined,
        path: 'src/app.ts',
        perPage: 20,
      });
    });

    it('should respect custom limit', async () => {
      const mockCommits = Array.from({ length: 100 }, (_, i) => ({
        id: `commit-${i}`,
        short_id: `commit-${i}`,
        title: `Commit ${i}`,
        message: `Message ${i}`,
        author_name: 'Author',
        author_email: 'author@example.com',
        created_at: '2024-01-01T00:00:00Z',
      }));

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.list('project-1', { limit: 10 });

      expect(result).toHaveLength(10);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: undefined,
        since: undefined,
        until: undefined,
        path: undefined,
        perPage: 10,
      });
    });
  });

  describe('search', () => {
    it('should search commits by message', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          title: 'Fix bug in authentication',
          message: 'Fix bug in authentication module',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'commit2',
          title: 'Add new feature',
          message: 'Add new feature for users',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 'commit3',
          title: 'Fix typo in documentation',
          message: 'Fix typo in README',
          author_name: 'Bob Smith',
          author_email: 'bob@example.com',
          created_at: '2024-01-03T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'fix');

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Fix bug in authentication');
      expect(result[1].title).toBe('Fix typo in documentation');
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: undefined,
        perPage: 100,
      });
    });

    it('should be case insensitive when searching', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          title: 'FIX BUG',
          message: 'FIX BUG IN CODE',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'fix');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('FIX BUG');
    });

    it('should search on specific ref', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          title: 'Feature commit',
          message: 'Feature commit on develop',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'feature', { ref: 'develop' });

      expect(result).toHaveLength(1);
      expect(mockGitlab.Commits.all).toHaveBeenCalledWith('project-1', {
        refName: 'develop',
        perPage: 100,
      });
    });

    it('should respect custom limit after filtering', async () => {
      const mockCommits = Array.from({ length: 50 }, (_, i) => ({
        id: `commit-${i}`,
        title: `Fix issue ${i}`,
        message: `Fix issue ${i}`,
        author_name: 'Author',
        author_email: 'author@example.com',
        created_at: '2024-01-01T00:00:00Z',
      }));

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'fix', { limit: 5 });

      expect(result).toHaveLength(5);
    });

    it('should return empty array when no matches found', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          title: 'Add feature',
          message: 'Add feature',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'nonexistent');

      expect(result).toHaveLength(0);
    });

    it('should handle commits with missing message or title', async () => {
      const mockCommits = [
        {
          id: 'commit1',
          title: undefined,
          message: undefined,
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'commit2',
          title: 'Valid commit',
          message: 'Valid message',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockGitlab.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.search('project-1', 'valid');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Valid commit');
    });
  });
});
