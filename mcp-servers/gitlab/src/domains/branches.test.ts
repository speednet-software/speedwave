import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBranchesClient } from './branches.js';

// Create inline mock
function createMockGitlab() {
  return {
    Branches: {
      all: vi.fn(),
      show: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    Repositories: {
      compare: vi.fn(),
    },
  };
}

describe('BranchesClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createBranchesClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createBranchesClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list branches with default limit', async () => {
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

      mockGitlab.Branches.all.mockResolvedValue(mockBranches);

      const result = await client.list('project-1');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('main');
      expect(result[0].protected).toBe(true);
      expect(result[0].default).toBe(true);
      expect(result[1].name).toBe('develop');
      expect(mockGitlab.Branches.all).toHaveBeenCalledWith('project-1', {
        search: undefined,
        perPage: 20,
      });
    });

    it('should filter branches by search query', async () => {
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

      mockGitlab.Branches.all.mockResolvedValue(mockBranches);

      const result = await client.list('project-1', { search: 'feature' });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('feature/auth');
      expect(mockGitlab.Branches.all).toHaveBeenCalledWith('project-1', {
        search: 'feature',
        perPage: 20,
      });
    });

    it('should respect custom limit', async () => {
      const mockBranches = Array.from({ length: 50 }, (_, i) => ({
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

      mockGitlab.Branches.all.mockResolvedValue(mockBranches);

      const result = await client.list('project-1', { limit: 10 });

      expect(result).toHaveLength(10);
      expect(mockGitlab.Branches.all).toHaveBeenCalledWith('project-1', {
        search: undefined,
        perPage: 10,
      });
    });
  });

  describe('get', () => {
    it('should get a specific branch', async () => {
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

      mockGitlab.Branches.show.mockResolvedValue(mockBranch);

      const result = await client.get('project-1', 'main');

      expect(result.name).toBe('main');
      expect(result.protected).toBe(true);
      expect(result.commit.id).toBe('abc123');
      expect(mockGitlab.Branches.show).toHaveBeenCalledWith('project-1', 'main');
    });

    it('should map branch with camelCase properties', async () => {
      const mockBranch = {
        name: 'develop',
        commit: {
          id: 'def456',
          shortId: 'def456',
          title: 'Test commit',
          message: 'Test commit message',
          authorName: 'Jane Doe',
          authorEmail: 'jane@example.com',
          createdAt: '2024-01-02T00:00:00Z',
        },
        protected: false,
        merged: false,
        default: false,
        webUrl: 'https://gitlab.com/project/repo/-/tree/develop',
      };

      mockGitlab.Branches.show.mockResolvedValue(mockBranch);

      const result = await client.get('project-1', 'develop');

      expect(result.web_url).toBe('https://gitlab.com/project/repo/-/tree/develop');
      expect(result.commit.author_name).toBe('Jane Doe');
      expect(result.commit.short_id).toBe('def456');
    });
  });

  describe('create', () => {
    it('should create a new branch', async () => {
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

      mockGitlab.Branches.create.mockResolvedValue(mockBranch);

      const result = await client.create('project-1', 'feature/new-feature', 'main');

      expect(result.name).toBe('feature/new-feature');
      expect(result.protected).toBe(false);
      expect(mockGitlab.Branches.create).toHaveBeenCalledWith(
        'project-1',
        'feature/new-feature',
        'main'
      );
    });
  });

  describe('delete', () => {
    it('should delete a branch', async () => {
      mockGitlab.Branches.remove.mockResolvedValue(undefined);

      await client.delete('project-1', 'feature/old-feature');

      expect(mockGitlab.Branches.remove).toHaveBeenCalledWith('project-1', 'feature/old-feature');
    });
  });

  describe('compare', () => {
    it('should compare two branches', async () => {
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

      mockGitlab.Repositories.compare.mockResolvedValue(mockComparison);

      const result = await client.compare('project-1', 'main', 'develop');

      expect(result.commits).toHaveLength(2);
      expect(result.commits[0].title).toBe('First commit');
      expect(result.diffs).toHaveLength(2);
      expect(result.diffs[0].old_path).toBe('file1.txt');
      expect(result.compare_timeout).toBe(false);
      expect(result.compare_same_ref).toBe(false);
      expect(mockGitlab.Repositories.compare).toHaveBeenCalledWith('project-1', 'main', 'develop');
    });

    it('should handle camelCase properties in comparison', async () => {
      const mockComparison = {
        commits: [
          {
            id: 'commit1',
            shortId: 'commit1',
            title: 'Test commit',
            message: 'Test commit message',
            authorName: 'John Doe',
            authorEmail: 'john@example.com',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        diffs: [
          {
            oldPath: 'old.txt',
            newPath: 'new.txt',
            diff: '@@ -1 +1 @@',
          },
        ],
        compareTimeout: true,
        compareSameRef: false,
      };

      mockGitlab.Repositories.compare.mockResolvedValue(mockComparison);

      const result = await client.compare('project-1', 'main', 'main');

      expect(result.commits[0].author_name).toBe('John Doe');
      expect(result.diffs[0].old_path).toBe('old.txt');
      expect(result.diffs[0].new_path).toBe('new.txt');
      expect(result.compare_timeout).toBe(true);
    });

    it('should handle empty commits and diffs', async () => {
      const mockComparison = {
        commits: [],
        diffs: [],
        compare_timeout: false,
        compare_same_ref: true,
      };

      mockGitlab.Repositories.compare.mockResolvedValue(mockComparison);

      const result = await client.compare('project-1', 'main', 'main');

      expect(result.commits).toHaveLength(0);
      expect(result.diffs).toHaveLength(0);
      expect(result.compare_same_ref).toBe(true);
    });
  });
});
