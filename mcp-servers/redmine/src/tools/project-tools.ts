/**
 * Project Tools - 3 tools for Redmine project operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { RedmineClient } from '../client.js';

const listProjectIdsTool: Tool = {
  name: 'listProjectIds',
  description: 'List project IDs with optional filters. Returns only IDs for efficiency.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'closed', 'archived', 'all'],
        description: 'Project status filter',
      },
      limit: { type: 'number', description: 'Max results (default 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
};

const getProjectFullTool: Tool = {
  name: 'getProjectFull',
  description: 'Get complete project data including trackers, categories, modules. No truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or identifier' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional data to include',
      },
    },
    required: ['project_id'],
  },
};

const searchProjectIdsTool: Tool = {
  name: 'searchProjectIds',
  description: 'Search projects by name, identifier or description. Returns matching IDs only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
    required: ['query'],
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createProjectTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
  if (!client) {
    return [
      { tool: listProjectIdsTool, handler: unconfigured },
      { tool: getProjectFullTool, handler: unconfigured },
      { tool: searchProjectIdsTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listProjectIdsTool,
      handler: async (params) => {
        try {
          const { status, limit, offset } = params as {
            status?: 'active' | 'closed' | 'archived' | 'all';
            limit?: number;
            offset?: number;
          };
          const result = await client.listProjects({ status, limit, offset });
          return jsonResult({
            ids: result.projects.map((p: { id: number }) => p.id),
            identifiers: result.projects.map((p: { id: number; identifier: string }) => ({
              id: p.id,
              identifier: p.identifier,
            })),
            total_count: result.total_count,
            offset: offset || 0,
            limit: limit || 100,
          });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: getProjectFullTool,
      handler: async (params) => {
        try {
          const { project_id, include = [] } = params as {
            project_id: string | number;
            include?: string[];
          };
          const result = await client.showProject(project_id, { include });
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: searchProjectIdsTool,
      handler: async (params) => {
        try {
          const { query, limit } = params as { query: string; limit?: number };
          const result = await client.searchProjects(query, { limit });
          return jsonResult({
            ids: result.projects.map((p: { id: number }) => p.id),
            projects: result.projects,
            total_count: result.total_count,
          });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
