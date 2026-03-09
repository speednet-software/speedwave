/**
 * Tests for GitLab Projects Domain
 *
 * Coverage: list, show, searchCode
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProjectsClient, type ProjectsClient } from './projects.js';

function createMockGitlab() {
  return {
    Projects: {
      all: vi.fn(),
      show: vi.fn(),
    },
    Search: {
      all: vi.fn(),
    },
  };
}

describe('ProjectsClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ProjectsClient;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createProjectsClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list projects with default options', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Project 1',
          pathWithNamespace: 'group/project-1',
          description: 'Test project',
          webUrl: 'https://gitlab.example.com/group/project-1',
          defaultBranch: 'main',
        },
        {
          id: 2,
          name: 'Project 2',
          pathWithNamespace: 'group/project-2',
          webUrl: 'https://gitlab.example.com/group/project-2',
        },
      ];

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.list();

      expect(mockGitlab.Projects.all).toHaveBeenCalledWith({
        search: undefined,
        perPage: 20,
        owned: undefined,
      });

      expect(result).toEqual([
        {
          id: 1,
          name: 'Project 1',
          path_with_namespace: 'group/project-1',
          description: 'Test project',
          web_url: 'https://gitlab.example.com/group/project-1',
          default_branch: 'main',
        },
        {
          id: 2,
          name: 'Project 2',
          path_with_namespace: 'group/project-2',
          description: undefined,
          web_url: 'https://gitlab.example.com/group/project-2',
          default_branch: undefined,
        },
      ]);
    });

    it('should list projects with search filter', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Search Project',
          pathWithNamespace: 'group/search-project',
          webUrl: 'https://gitlab.example.com/group/search-project',
        },
      ];

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.list({ search: 'test' });

      expect(mockGitlab.Projects.all).toHaveBeenCalledWith({
        search: 'test',
        perPage: 20,
        owned: undefined,
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Search Project');
    });

    it('should list projects with custom limit', async () => {
      const mockProjects = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        name: `Project ${i + 1}`,
        pathWithNamespace: `group/project-${i + 1}`,
        webUrl: `https://gitlab.example.com/group/project-${i + 1}`,
      }));

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.list({ limit: 10 });

      expect(mockGitlab.Projects.all).toHaveBeenCalledWith({
        search: undefined,
        perPage: 10,
        owned: undefined,
      });

      // Should limit results to 10
      expect(result).toHaveLength(10);
    });

    it('should list only owned projects', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'My Project',
          pathWithNamespace: 'me/my-project',
          webUrl: 'https://gitlab.example.com/me/my-project',
        },
      ];

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      await client.list({ owned: true });

      expect(mockGitlab.Projects.all).toHaveBeenCalledWith({
        search: undefined,
        perPage: 20,
        owned: true,
      });
    });

    it('should handle snake_case properties', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Project',
          path_with_namespace: 'group/project',
          web_url: 'https://gitlab.example.com/group/project',
          defaultBranch: 'develop', // API returns camelCase
        },
      ];

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.list();

      expect(result[0].path_with_namespace).toBe('group/project');
      expect(result[0].web_url).toBe('https://gitlab.example.com/group/project');
      expect(result[0].default_branch).toBe('develop');
    });

    it('should handle projects without optional fields', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Minimal Project',
          pathWithNamespace: 'group/minimal',
          webUrl: 'https://gitlab.example.com/group/minimal',
        },
      ];

      mockGitlab.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.list();

      expect(result[0].description).toBeUndefined();
      expect(result[0].default_branch).toBeUndefined();
    });

    it('should combine search, limit, and owned options', async () => {
      mockGitlab.Projects.all.mockResolvedValue([]);

      await client.list({ search: 'api', limit: 5, owned: true });

      expect(mockGitlab.Projects.all).toHaveBeenCalledWith({
        search: 'api',
        perPage: 5,
        owned: true,
      });
    });
  });

  describe('show', () => {
    it('should show project by ID', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        description: 'A test project',
        webUrl: 'https://gitlab.example.com/group/test-project',
        defaultBranch: 'main',
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show(1);

      expect(mockGitlab.Projects.show).toHaveBeenCalledWith(1, {
        license: undefined,
        statistics: undefined,
      });

      expect(result).toEqual({
        id: 1,
        name: 'Test Project',
        path_with_namespace: 'group/test-project',
        description: 'A test project',
        web_url: 'https://gitlab.example.com/group/test-project',
        default_branch: 'main',
      });
    });

    it('should show project by path', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        webUrl: 'https://gitlab.example.com/group/test-project',
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show('group/test-project');

      expect(mockGitlab.Projects.show).toHaveBeenCalledWith('group/test-project', {
        license: undefined,
        statistics: undefined,
      });

      expect(result.id).toBe(1);
    });

    it('should include license when requested', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        webUrl: 'https://gitlab.example.com/group/test-project',
        license: {
          key: 'mit',
          name: 'MIT License',
          url: 'https://opensource.org/licenses/MIT',
        },
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show(1, { license: true });

      expect(mockGitlab.Projects.show).toHaveBeenCalledWith(1, {
        license: true,
        statistics: undefined,
      });

      expect(result.license).toBeDefined();
      expect(result.license).toEqual(mockProject.license);
    });

    it('should include statistics when requested', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        webUrl: 'https://gitlab.example.com/group/test-project',
        statistics: {
          commit_count: 100,
          storage_size: 1024000,
          repository_size: 512000,
        },
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show(1, { statistics: true });

      expect(mockGitlab.Projects.show).toHaveBeenCalledWith(1, {
        license: undefined,
        statistics: true,
      });

      expect(result.statistics).toBeDefined();
      expect(result.statistics).toEqual(mockProject.statistics);
    });

    it('should include both license and statistics when requested', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        webUrl: 'https://gitlab.example.com/group/test-project',
        license: { key: 'apache-2.0', name: 'Apache 2.0' },
        statistics: { commit_count: 50 },
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show(1, { license: true, statistics: true });

      expect(mockGitlab.Projects.show).toHaveBeenCalledWith(1, {
        license: true,
        statistics: true,
      });

      expect(result.license).toBeDefined();
      expect(result.statistics).toBeDefined();
    });

    it('should handle project without optional fields', async () => {
      const mockProject = {
        id: 1,
        name: 'Minimal Project',
        pathWithNamespace: 'group/minimal',
        webUrl: 'https://gitlab.example.com/group/minimal',
      };

      mockGitlab.Projects.show.mockResolvedValue(mockProject);

      const result = await client.show(1);

      expect(result.description).toBeUndefined();
      expect(result.default_branch).toBeUndefined();
    });
  });

  describe('searchCode', () => {
    it('should search code globally', async () => {
      const mockResults = [
        {
          filename: 'test.js',
          data: 'const test = "value";',
          path: 'src/test.js',
          project_id: 1,
        },
        {
          filename: 'test2.js',
          data: 'const test = "another";',
          path: 'lib/test2.js',
          project_id: 2,
        },
      ];

      mockGitlab.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('test');

      expect(mockGitlab.Search.all).toHaveBeenCalledWith('blobs', 'test');
      expect(result).toEqual(mockResults);
      expect(result).toHaveLength(2);
    });

    it('should search code within a specific project', async () => {
      const mockResults = [
        {
          filename: 'test.js',
          data: 'const test = "value";',
          path: 'src/test.js',
          project_id: 1,
        },
      ];

      mockGitlab.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('test', { project_id: 1 });

      expect(mockGitlab.Search.all).toHaveBeenCalledWith('blobs', 'test', {
        projectId: 1,
      });
      expect(result).toHaveLength(1);
    });

    it('should search code with project path string', async () => {
      const mockResults = [
        {
          filename: 'config.yml',
          data: 'database: postgres',
          path: 'config/config.yml',
          project_id: 5,
        },
      ];

      mockGitlab.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('postgres', { project_id: 'group/project' });

      expect(mockGitlab.Search.all).toHaveBeenCalledWith('blobs', 'postgres', {
        projectId: 'group/project',
      });
      expect(result).toHaveLength(1);
    });

    it('should handle empty search results', async () => {
      mockGitlab.Search.all.mockResolvedValue([]);

      const result = await client.searchCode('nonexistent');

      expect(mockGitlab.Search.all).toHaveBeenCalledWith('blobs', 'nonexistent');
      expect(result).toEqual([]);
    });

    it('should search for complex patterns', async () => {
      const mockResults = [
        {
          filename: 'api.ts',
          data: 'export function getUserById(id: string)',
          path: 'src/api.ts',
        },
      ];

      mockGitlab.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('getUserById');

      expect(mockGitlab.Search.all).toHaveBeenCalledWith('blobs', 'getUserById');
      expect(result).toHaveLength(1);
    });

    it('should return results as unknown array', async () => {
      const mockResults = [{ custom: 'field', other: 123 }];

      mockGitlab.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('anything');

      // Type should be unknown[]
      expect(result).toEqual(mockResults);
    });
  });
});
