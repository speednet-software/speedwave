/**
 * Comprehensive tests for project-tools.ts
 *
 * Tests cover:
 * - list_project_ids: listing projects with search, membership, archived options
 * - get_project_full: getting full project data with optional includes
 * - search_code: searching code in projects
 * - Unconfigured client handling
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createProjectTools } from './project-tools.js';
import { GitLabClient } from '../client.js';

// Mock client type with all required methods
type MockClient = {
  listProjects: Mock;
  showProject: Mock;
  searchCode: Mock;
  formatError?: Mock;
};

describe('createProjectTools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      listProjects: vi.fn(),
      showProject: vi.fn(),
      searchCode: vi.fn(),
    };
  });

  describe('listProjectIds', () => {
    it('lists projects with default options', async () => {
      const mockProjects = [
        { id: 1, path_with_namespace: 'group/project1', name: 'Project 1' },
        { id: 2, path_with_namespace: 'group/project2', name: 'Project 2' },
      ];
      mockClient.listProjects.mockResolvedValue(mockProjects);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({});

      expect(mockClient.listProjects).toHaveBeenCalledWith({});
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projects: [
                  { id: 1, path: 'group/project1' },
                  { id: 2, path: 'group/project2' },
                ],
                count: 2,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('lists projects with search parameter', async () => {
      const mockProjects = [{ id: 1, path_with_namespace: 'group/backend', name: 'Backend' }];
      mockClient.listProjects.mockResolvedValue(mockProjects);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({ search: 'backend' });

      expect(mockClient.listProjects).toHaveBeenCalledWith({ search: 'backend' });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projects: [{ id: 1, path: 'group/backend' }],
                count: 1,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('lists projects with limit parameter', async () => {
      const mockProjects = [
        { id: 1, path_with_namespace: 'group/project1', name: 'Project 1' },
        { id: 2, path_with_namespace: 'group/project2', name: 'Project 2' },
        { id: 3, path_with_namespace: 'group/project3', name: 'Project 3' },
      ];
      mockClient.listProjects.mockResolvedValue(mockProjects);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({ limit: 3 });

      expect(mockClient.listProjects).toHaveBeenCalledWith({ limit: 3 });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projects: [
                  { id: 1, path: 'group/project1' },
                  { id: 2, path: 'group/project2' },
                  { id: 3, path: 'group/project3' },
                ],
                count: 3,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('maps project results to id and path only', async () => {
      const mockProjects = [
        {
          id: 42,
          path_with_namespace: 'org/awesome-project',
          name: 'Awesome Project',
          description: 'Some description',
          created_at: '2024-01-01',
          // ... many other fields
        },
      ];
      mockClient.listProjects.mockResolvedValue(mockProjects);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({});

      const parsedContent = JSON.parse(result.content[0].text);
      expect(parsedContent.projects).toEqual([{ id: 42, path: 'org/awesome-project' }]);
    });

    it('returns empty list when no projects found', async () => {
      mockClient.listProjects.mockResolvedValue([]);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                projects: [],
                count: 0,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('handles API errors', async () => {
      const error = new Error('API rate limit exceeded');
      mockClient.listProjects.mockRejectedValue(error);
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('API rate limit exceeded');

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: API rate limit exceeded' }],
        isError: true,
      });
    });
  });

  describe('getProjectFull', () => {
    it('gets project by numeric id', async () => {
      const mockProject = {
        id: 123,
        name: 'My Project',
        path_with_namespace: 'group/my-project',
        description: 'Project description',
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({ project_id: 123 });

      expect(mockClient.showProject).toHaveBeenCalledWith(123, {
        license: false,
        statistics: false,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('gets project by string path', async () => {
      const mockProject = {
        id: 456,
        name: 'Backend API',
        path_with_namespace: 'acme/backend-api',
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({ project_id: 'acme/backend-api' });

      expect(mockClient.showProject).toHaveBeenCalledWith('acme/backend-api', {
        license: false,
        statistics: false,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('includes license when specified', async () => {
      const mockProject = {
        id: 789,
        name: 'Licensed Project',
        license: { key: 'mit', name: 'MIT License' },
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({
        project_id: 789,
        include: ['license'],
      });

      expect(mockClient.showProject).toHaveBeenCalledWith(789, {
        license: true,
        statistics: false,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('includes statistics when specified', async () => {
      const mockProject = {
        id: 101,
        name: 'Stats Project',
        statistics: {
          commit_count: 150,
          storage_size: 5000000,
        },
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({
        project_id: 101,
        include: ['statistics'],
      });

      expect(mockClient.showProject).toHaveBeenCalledWith(101, {
        license: false,
        statistics: true,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('includes both license and statistics when specified', async () => {
      const mockProject = {
        id: 202,
        name: 'Full Data Project',
        license: { key: 'apache-2.0', name: 'Apache License 2.0' },
        statistics: {
          commit_count: 500,
          storage_size: 10000000,
        },
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({
        project_id: 202,
        include: ['license', 'statistics'],
      });

      expect(mockClient.showProject).toHaveBeenCalledWith(202, {
        license: true,
        statistics: true,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('handles empty include array', async () => {
      const mockProject = { id: 303, name: 'Simple Project' };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({
        project_id: 303,
        include: [],
      });

      expect(mockClient.showProject).toHaveBeenCalledWith(303, {
        license: false,
        statistics: false,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockProject, null, 2),
          },
        ],
      });
    });

    it('handles project not found error', async () => {
      const error = new Error('404 Project Not Found');
      mockClient.showProject.mockRejectedValue(error);
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('Resource not found in GitLab.');

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({ project_id: 'nonexistent/project' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission denied error', async () => {
      const error = new Error('403 Forbidden');
      mockClient.showProject.mockRejectedValue(error);
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue(
        'Permission denied. Your GitLab token may not have sufficient permissions.'
      );

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({ project_id: 999 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });
  });

  describe('searchCode', () => {
    it('searches code with query only', async () => {
      const mockResults = [
        {
          basename: 'app.ts',
          data: 'function authenticate() { ... }',
          path: 'src/app.ts',
          filename: 'src/app.ts',
          project_id: 1,
          ref: 'main',
        },
      ];
      mockClient.searchCode.mockResolvedValue(mockResults);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({ query: 'authenticate' });

      expect(mockClient.searchCode).toHaveBeenCalledWith('authenticate', {});
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockResults, null, 2),
          },
        ],
      });
    });

    it('searches code with project_id filter', async () => {
      const mockResults = [
        {
          basename: 'config.ts',
          data: 'export const API_KEY = ...',
          path: 'src/config.ts',
          filename: 'src/config.ts',
          project_id: 42,
          ref: 'main',
        },
      ];
      mockClient.searchCode.mockResolvedValue(mockResults);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({
        query: 'API_KEY',
        project_id: 42,
      });

      expect(mockClient.searchCode).toHaveBeenCalledWith('API_KEY', { project_id: 42 });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockResults, null, 2),
          },
        ],
      });
    });

    it('searches code with string project_id', async () => {
      const mockResults = [
        {
          basename: 'index.ts',
          data: 'import { Router } from ...',
          path: 'src/index.ts',
          filename: 'src/index.ts',
          project_id: 123,
          ref: 'main',
        },
      ];
      mockClient.searchCode.mockResolvedValue(mockResults);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({
        query: 'Router',
        project_id: 'group/project',
      });

      expect(mockClient.searchCode).toHaveBeenCalledWith('Router', {
        project_id: 'group/project',
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockResults, null, 2),
          },
        ],
      });
    });

    it('returns empty results when no matches found', async () => {
      mockClient.searchCode.mockResolvedValue([]);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({ query: 'nonexistentfunction' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify([], null, 2),
          },
        ],
      });
    });

    it('handles complex search queries', async () => {
      const mockResults = [
        {
          basename: 'database.ts',
          data: 'class Database { connect() { ... } }',
          path: 'src/database.ts',
          filename: 'src/database.ts',
          project_id: 7,
          ref: 'main',
        },
      ];
      mockClient.searchCode.mockResolvedValue(mockResults);

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({
        query: 'class Database',
      });

      expect(mockClient.searchCode).toHaveBeenCalledWith('class Database', {});
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockResults, null, 2),
          },
        ],
      });
    });

    it('handles search API errors', async () => {
      const error = new Error('Search service unavailable');
      mockClient.searchCode.mockRejectedValue(error);
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('Search service unavailable');

      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({ query: 'test' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Search service unavailable' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for list_project_ids when client is null', async () => {
      const tools = createProjectTools(null);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      const result = await listProjectIdsTool!.handler({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for get_project_full when client is null', async () => {
      const tools = createProjectTools(null);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      const result = await getProjectFullTool!.handler({ project_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for search_code when client is null', async () => {
      const tools = createProjectTools(null);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      const result = await searchCodeTool!.handler({ query: 'test' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns all three tools even when unconfigured', () => {
      const tools = createProjectTools(null);

      expect(tools.length).toBe(3);
      expect(tools.map((t) => t.tool.name).sort()).toEqual([
        'getProjectFull',
        'listProjectIds',
        'searchCode',
      ]);
    });
  });

  describe('tool definitions', () => {
    it('returns correct tool definitions', () => {
      const tools = createProjectTools(mockClient as unknown as GitLabClient);

      expect(tools.length).toBe(3);

      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      expect(listProjectIdsTool?.tool.description).toBe(
        'List project IDs and paths. Use get_project_full for details.'
      );
      expect(listProjectIdsTool?.tool.inputSchema.properties).toHaveProperty('membership');
      expect(listProjectIdsTool?.tool.inputSchema.properties).toHaveProperty('archived');
      expect(listProjectIdsTool?.tool.inputSchema.properties).toHaveProperty('search');
      expect(listProjectIdsTool?.tool.inputSchema.properties).toHaveProperty('limit');

      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      expect(getProjectFullTool?.tool.description).toBe(
        'Get complete project data. No truncation.'
      );
      expect(getProjectFullTool?.tool.inputSchema.properties).toHaveProperty('project_id');
      expect(getProjectFullTool?.tool.inputSchema.properties).toHaveProperty('include');
      expect(getProjectFullTool?.tool.inputSchema.required).toEqual(['project_id']);

      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');
      expect(searchCodeTool?.tool.description).toBe('Search for code in GitLab projects');
      expect(searchCodeTool?.tool.inputSchema.properties).toHaveProperty('query');
      expect(searchCodeTool?.tool.inputSchema.properties).toHaveProperty('project_id');
      expect(searchCodeTool?.tool.inputSchema.required).toEqual(['query']);
    });

    it('has correct include enum values for get_project_full', () => {
      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const includeProperty = getProjectFullTool?.tool.inputSchema.properties.include;
      expect(includeProperty).toBeDefined();
      expect(includeProperty.type).toBe('array');
      expect(includeProperty.items.enum).toEqual(['license', 'statistics']);
    });

    it('has correct project_id type for get_project_full', () => {
      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const projectIdProperty = getProjectFullTool?.tool.inputSchema.properties.project_id;
      expect(projectIdProperty).toBeDefined();
      expect(projectIdProperty.type).toEqual(['string', 'number']);
    });

    it('has correct project_id type for search_code', () => {
      const tools = createProjectTools(mockClient as unknown as GitLabClient);
      const searchCodeTool = tools.find((t) => t.tool.name === 'searchCode');

      const projectIdProperty = searchCodeTool?.tool.inputSchema.properties.project_id;
      expect(projectIdProperty).toBeDefined();
      expect(projectIdProperty.type).toEqual(['string', 'number']);
    });
  });
});
