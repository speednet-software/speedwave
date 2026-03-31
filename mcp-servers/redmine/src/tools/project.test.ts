/**
 * Project Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createProjectTools } from './project-tools.js';
import { RedmineClient } from '../client.js';

type MockClient = {
  listProjects: Mock;
  showProject: Mock;
  searchProjects: Mock;
};

const createMockClient = (): MockClient => ({
  listProjects: vi.fn(),
  showProject: vi.fn(),
  searchProjects: vi.fn(),
});

describe('Project Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.spyOn(RedmineClient, 'formatError').mockImplementation((error) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
  });

  describe('when client is null', () => {
    it('should return unconfigured error for list_project_ids', async () => {
      const tools = createProjectTools(null);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');
      expect(listProjectIdsTool).toBeDefined();

      const result = await listProjectIdsTool!.handler({});
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });

    it('should return unconfigured error for get_project_full', async () => {
      const tools = createProjectTools(null);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');
      expect(getProjectFullTool).toBeDefined();

      const result = await getProjectFullTool!.handler({ project_id: 'test' });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });

    it('should return unconfigured error for search_project_ids', async () => {
      const tools = createProjectTools(null);
      const searchProjectIdsTool = tools.find((t) => t.tool.name === 'searchProjectIds');
      expect(searchProjectIdsTool).toBeDefined();

      const result = await searchProjectIdsTool!.handler({ query: 'test' });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });
  });

  describe('listProjectIds', () => {
    it('should list project IDs with default parameters', async () => {
      const mockResponse = {
        projects: [
          {
            id: 1,
            identifier: 'project-1',
            name: 'Project 1',
            status: 1,
            is_public: true,
            created_on: '2024-01-01',
            updated_on: '2024-01-01',
          },
          {
            id: 2,
            identifier: 'project-2',
            name: 'Project 2',
            status: 1,
            is_public: true,
            created_on: '2024-01-02',
            updated_on: '2024-01-02',
          },
        ],
        total_count: 2,
      };
      mockClient.listProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');

      const result = await listProjectIdsTool!.handler({});

      expect(mockClient.listProjects).toHaveBeenCalledWith({
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [1, 2],
                identifiers: [
                  { id: 1, identifier: 'project-1' },
                  { id: 2, identifier: 'project-2' },
                ],
                total_count: 2,
                offset: 0,
                limit: 100,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should list project IDs with status filter', async () => {
      const mockResponse = {
        projects: [
          {
            id: 1,
            identifier: 'active-project',
            name: 'Active Project',
            status: 1,
            is_public: true,
            created_on: '2024-01-01',
            updated_on: '2024-01-01',
          },
        ],
        total_count: 1,
      };
      mockClient.listProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');

      const result = await listProjectIdsTool!.handler({ status: 'active' });

      expect(mockClient.listProjects).toHaveBeenCalledWith({
        status: 'active',
        limit: undefined,
        offset: undefined,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [1],
                identifiers: [{ id: 1, identifier: 'active-project' }],
                total_count: 1,
                offset: 0,
                limit: 100,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should list project IDs with limit and offset', async () => {
      const mockResponse = {
        projects: [
          {
            id: 11,
            identifier: 'project-11',
            name: 'Project 11',
            status: 1,
            is_public: true,
            created_on: '2024-01-01',
            updated_on: '2024-01-01',
          },
        ],
        total_count: 50,
      };
      mockClient.listProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');

      const result = await listProjectIdsTool!.handler({ limit: 1, offset: 10 });

      expect(mockClient.listProjects).toHaveBeenCalledWith({
        status: undefined,
        limit: 1,
        offset: 10,
      });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [11],
                identifiers: [{ id: 11, identifier: 'project-11' }],
                total_count: 50,
                offset: 10,
                limit: 1,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should handle empty project list', async () => {
      const mockResponse = { projects: [], total_count: 0 };
      mockClient.listProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');

      const result = await listProjectIdsTool!.handler({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [],
                identifiers: [],
                total_count: 0,
                offset: 0,
                limit: 100,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should handle errors', async () => {
      mockClient.listProjects.mockRejectedValue(new Error('Network error'));

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const listProjectIdsTool = tools.find((t) => t.tool.name === 'listProjectIds');

      const result = await listProjectIdsTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Network error' }],
      });
    });
  });

  describe('getProjectFull', () => {
    it('should get full project data without include', async () => {
      const mockProject = {
        id: 1,
        identifier: 'test-project',
        name: 'Test Project',
        description: 'A test project',
        status: 1,
        is_public: true,
        created_on: '2024-01-01',
        updated_on: '2024-01-01',
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const result = await getProjectFullTool!.handler({ project_id: 'test-project' });

      expect(mockClient.showProject).toHaveBeenCalledWith('test-project', { include: [] });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockProject, null, 2) }],
      });
    });

    it('should get full project data with include array', async () => {
      const mockProject = {
        id: 1,
        identifier: 'test-project',
        name: 'Test Project',
        status: 1,
        is_public: true,
        created_on: '2024-01-01',
        updated_on: '2024-01-01',
        trackers: [{ id: 1, name: 'Bug' }],
        issue_categories: [{ id: 1, name: 'Development' }],
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const result = await getProjectFullTool!.handler({
        project_id: 1,
        include: ['trackers', 'issue_categories'],
      });

      expect(mockClient.showProject).toHaveBeenCalledWith(1, {
        include: ['trackers', 'issue_categories'],
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockProject, null, 2) }],
      });
    });

    it('should handle numeric project_id', async () => {
      const mockProject = {
        id: 42,
        identifier: 'project-42',
        name: 'Project 42',
        status: 1,
        is_public: false,
        created_on: '2024-01-01',
        updated_on: '2024-01-01',
      };
      mockClient.showProject.mockResolvedValue(mockProject);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const result = await getProjectFullTool!.handler({ project_id: 42 });

      expect(mockClient.showProject).toHaveBeenCalledWith(42, { include: [] });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockProject, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.showProject.mockRejectedValue(new Error('Project not found'));

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const getProjectFullTool = tools.find((t) => t.tool.name === 'getProjectFull');

      const result = await getProjectFullTool!.handler({ project_id: 'nonexistent' });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Project not found' }],
      });
    });
  });

  describe('searchProjectIds', () => {
    it('should search projects by query', async () => {
      const mockResponse = {
        projects: [
          { id: 1, identifier: 'test-project', name: 'Test Project' },
          { id: 2, identifier: 'test-project-2', name: 'Test Project 2' },
        ],
        total_count: 2,
      };
      mockClient.searchProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const searchProjectIdsTool = tools.find((t) => t.tool.name === 'searchProjectIds');

      const result = await searchProjectIdsTool!.handler({ query: 'test' });

      expect(mockClient.searchProjects).toHaveBeenCalledWith('test', { limit: undefined });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [1, 2],
                projects: mockResponse.projects,
                total_count: 2,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should search projects with limit', async () => {
      const mockResponse = {
        projects: [{ id: 1, identifier: 'project-1', name: 'Project 1' }],
        total_count: 10,
      };
      mockClient.searchProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const searchProjectIdsTool = tools.find((t) => t.tool.name === 'searchProjectIds');

      const result = await searchProjectIdsTool!.handler({ query: 'project', limit: 1 });

      expect(mockClient.searchProjects).toHaveBeenCalledWith('project', { limit: 1 });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [1],
                projects: mockResponse.projects,
                total_count: 10,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should handle no results', async () => {
      const mockResponse = { projects: [], total_count: 0 };
      mockClient.searchProjects.mockResolvedValue(mockResponse);

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const searchProjectIdsTool = tools.find((t) => t.tool.name === 'searchProjectIds');

      const result = await searchProjectIdsTool!.handler({ query: 'nonexistent' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ids: [],
                projects: [],
                total_count: 0,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should handle errors', async () => {
      mockClient.searchProjects.mockRejectedValue(new Error('Search failed'));

      const tools = createProjectTools(mockClient as unknown as RedmineClient);
      const searchProjectIdsTool = tools.find((t) => t.tool.name === 'searchProjectIds');

      const result = await searchProjectIdsTool!.handler({ query: 'test' });

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Search failed' }],
      });
    });
  });
});
