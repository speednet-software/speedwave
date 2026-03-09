import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRepositoryClient } from './repository.js';

// Create inline mock
function createMockGitlab() {
  return {
    Repositories: {
      allRepositoryTrees: vi.fn(),
    },
    RepositoryFiles: {
      show: vi.fn(),
      allFileBlames: vi.fn(),
    },
  };
}

describe('RepositoryClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createRepositoryClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createRepositoryClient(mockGitlab as any);
  });

  describe('getTree', () => {
    it('should get repository tree with default options', async () => {
      const mockTree = [
        {
          id: '1',
          name: 'src',
          type: 'tree',
          path: 'src',
          mode: '040000',
        },
        {
          id: '2',
          name: 'README.md',
          type: 'blob',
          path: 'README.md',
          mode: '100644',
        },
      ];

      mockGitlab.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree('project-1');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('src');
      expect(result[0].type).toBe('tree');
      expect(result[1].name).toBe('README.md');
      expect(result[1].type).toBe('blob');
      expect(mockGitlab.Repositories.allRepositoryTrees).toHaveBeenCalledWith('project-1', {
        path: undefined,
        ref: undefined,
        recursive: undefined,
      });
    });

    it('should filter by path', async () => {
      const mockTree = [
        {
          id: '3',
          name: 'app.ts',
          type: 'blob',
          path: 'src/app.ts',
          mode: '100644',
        },
        {
          id: '4',
          name: 'utils.ts',
          type: 'blob',
          path: 'src/utils.ts',
          mode: '100644',
        },
      ];

      mockGitlab.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree('project-1', { path: 'src' });

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('src/app.ts');
      expect(mockGitlab.Repositories.allRepositoryTrees).toHaveBeenCalledWith('project-1', {
        path: 'src',
        ref: undefined,
        recursive: undefined,
      });
    });

    it('should use specific ref', async () => {
      const mockTree = [
        {
          id: '5',
          name: 'feature.ts',
          type: 'blob',
          path: 'feature.ts',
          mode: '100644',
        },
      ];

      mockGitlab.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree('project-1', { ref: 'develop' });

      expect(result).toHaveLength(1);
      expect(mockGitlab.Repositories.allRepositoryTrees).toHaveBeenCalledWith('project-1', {
        path: undefined,
        ref: 'develop',
        recursive: undefined,
      });
    });

    it('should get recursive tree', async () => {
      const mockTree = [
        {
          id: '1',
          name: 'app.ts',
          type: 'blob',
          path: 'src/app.ts',
          mode: '100644',
        },
        {
          id: '2',
          name: 'helper.ts',
          type: 'blob',
          path: 'src/utils/helper.ts',
          mode: '100644',
        },
      ];

      mockGitlab.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree('project-1', { recursive: true });

      expect(result).toHaveLength(2);
      expect(mockGitlab.Repositories.allRepositoryTrees).toHaveBeenCalledWith('project-1', {
        path: undefined,
        ref: undefined,
        recursive: true,
      });
    });

    it('should handle empty tree', async () => {
      mockGitlab.Repositories.allRepositoryTrees.mockResolvedValue([]);

      const result = await client.getTree('project-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('getFile', () => {
    it('should get file content with default ref', async () => {
      const mockFile = {
        fileName: 'app.ts',
        filePath: 'src/app.ts',
        size: 1024,
        encoding: 'text',
        content: 'console.log("Hello");',
        ref: 'main',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'src/app.ts');

      expect(result.file_name).toBe('app.ts');
      expect(result.file_path).toBe('src/app.ts');
      expect(result.content).toBe('console.log("Hello");');
      expect(result.encoding).toBe('text');
      expect(result.size).toBe(1024);
      expect(result.ref).toBe('main');
      expect(mockGitlab.RepositoryFiles.show).toHaveBeenCalledWith(
        'project-1',
        'src/app.ts',
        'main'
      );
    });

    it('should get file content with specific ref', async () => {
      const mockFile = {
        fileName: 'feature.ts',
        filePath: 'src/feature.ts',
        size: 2048,
        encoding: 'text',
        content: 'export const feature = true;',
        ref: 'develop',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'src/feature.ts', 'develop');

      expect(result.file_name).toBe('feature.ts');
      expect(result.ref).toBe('develop');
      expect(mockGitlab.RepositoryFiles.show).toHaveBeenCalledWith(
        'project-1',
        'src/feature.ts',
        'develop'
      );
    });

    it('should decode base64 content', async () => {
      const originalContent = 'Hello World!';
      const base64Content = Buffer.from(originalContent).toString('base64');

      const mockFile = {
        fileName: 'data.txt',
        filePath: 'data.txt',
        size: 12,
        encoding: 'base64',
        content: base64Content,
        ref: 'main',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'data.txt');

      expect(result.content).toBe(originalContent);
      expect(result.encoding).toBe('base64');
    });

    it('should handle snake_case properties', async () => {
      const mockFile = {
        file_name: 'test.ts',
        file_path: 'src/test.ts',
        size: 512,
        encoding: 'text',
        content: 'test content',
        ref: 'main',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'src/test.ts');

      expect(result.file_name).toBe('test.ts');
      expect(result.file_path).toBe('src/test.ts');
    });

    it('should fallback to filePath parameter if file_path is missing', async () => {
      const mockFile = {
        fileName: 'app.ts',
        // filePath missing
        size: 1024,
        encoding: 'text',
        content: 'content',
        ref: 'main',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'src/app.ts');

      expect(result.file_path).toBe('src/app.ts');
    });

    it('should handle empty content', async () => {
      const mockFile = {
        fileName: 'empty.txt',
        filePath: 'empty.txt',
        size: 0,
        encoding: 'text',
        content: '',
        ref: 'main',
      };

      mockGitlab.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile('project-1', 'empty.txt');

      expect(result.content).toBe('');
      expect(result.size).toBe(0);
    });
  });

  describe('getBlame', () => {
    it('should get file blame with default ref', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            short_id: 'commit1',
            title: 'Initial commit',
            message: 'Initial commit',
            author_name: 'John Doe',
            author_email: 'john@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          lines: ['line 1', 'line 2'],
        },
        {
          commit: {
            id: 'commit2',
            short_id: 'commit2',
            title: 'Update file',
            message: 'Update file',
            author_name: 'Jane Doe',
            author_email: 'jane@example.com',
            created_at: '2024-01-02T00:00:00Z',
          },
          lines: ['line 3', 'line 4'],
        },
      ];

      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame('project-1', 'src/app.ts');

      expect(result).toHaveLength(2);
      expect(result[0].commit.id).toBe('commit1');
      expect(result[0].commit.author_name).toBe('John Doe');
      expect(result[0].lines).toEqual(['line 1', 'line 2']);
      expect(result[1].commit.id).toBe('commit2');
      expect(result[1].lines).toEqual(['line 3', 'line 4']);
      expect(mockGitlab.RepositoryFiles.allFileBlames).toHaveBeenCalledWith(
        'project-1',
        'src/app.ts',
        'main'
      );
    });

    it('should get file blame with specific ref', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            short_id: 'commit1',
            title: 'Feature commit',
            message: 'Feature commit',
            author_name: 'Developer',
            author_email: 'dev@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          lines: ['code line'],
        },
      ];

      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame('project-1', 'src/feature.ts', 'develop');

      expect(result).toHaveLength(1);
      expect(mockGitlab.RepositoryFiles.allFileBlames).toHaveBeenCalledWith(
        'project-1',
        'src/feature.ts',
        'develop'
      );
    });

    it('should handle camelCase commit properties', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            shortId: 'commit1',
            title: 'Test commit',
            message: 'Test commit message',
            authorName: 'John Doe',
            authorEmail: 'john@example.com',
            createdAt: '2024-01-01T00:00:00Z',
          },
          lines: ['line 1'],
        },
      ];

      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame('project-1', 'src/app.ts');

      expect(result[0].commit.short_id).toBe('commit1');
      expect(result[0].commit.author_name).toBe('John Doe');
      expect(result[0].commit.author_email).toBe('john@example.com');
      expect(result[0].commit.created_at).toBe('2024-01-01T00:00:00Z');
    });

    it('should handle empty lines array', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            short_id: 'commit1',
            title: 'Commit',
            message: 'Commit message',
            author_name: 'Author',
            author_email: 'author@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          lines: [],
        },
      ];

      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame('project-1', 'src/empty.ts');

      expect(result[0].lines).toEqual([]);
    });

    it('should handle non-array lines gracefully', async () => {
      const mockBlame = [
        {
          commit: {
            id: 'commit1',
            short_id: 'commit1',
            title: 'Commit',
            message: 'Commit message',
            author_name: 'Author',
            author_email: 'author@example.com',
            created_at: '2024-01-01T00:00:00Z',
          },
          lines: null, // Invalid lines
        },
      ];

      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame('project-1', 'src/app.ts');

      expect(result[0].lines).toEqual([]);
    });

    it('should return empty array for non-array blame response', async () => {
      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue(null);

      const result = await client.getBlame('project-1', 'src/app.ts');

      expect(result).toEqual([]);
    });

    it('should handle empty blame array', async () => {
      mockGitlab.RepositoryFiles.allFileBlames.mockResolvedValue([]);

      const result = await client.getBlame('project-1', 'src/new-file.ts');

      expect(result).toEqual([]);
    });
  });
});
