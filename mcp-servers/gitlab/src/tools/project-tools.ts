/**
 * Project Tools - 3 tools for GitLab project operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listProjectIdsTool: Tool = {
  name: 'listProjectIds',
  description: 'List project IDs and paths. Use get_project_full for details.',
  inputSchema: {
    type: 'object',
    properties: {
      membership: { type: 'boolean', description: 'Only member projects (default true)' },
      archived: { type: 'boolean', description: 'Include archived (default false)' },
      search: { type: 'string', description: 'Search by name' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
  },
};

const getProjectFullTool: Tool = {
  name: 'getProjectFull',
  description: 'Get complete project data. No truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['license', 'statistics'] },
        description: 'Additional data',
      },
    },
    required: ['project_id'],
  },
};

const searchCodeTool: Tool = {
  name: 'searchCode',
  description: 'Search for code in GitLab projects',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      project_id: {
        type: ['string', 'number'],
        description: 'Limit search to specific project (optional)',
      },
    },
    required: ['query'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createProjectTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listProjectIdsTool, handler: unconfigured },
      { tool: getProjectFullTool, handler: unconfigured },
      { tool: searchCodeTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listProjectIdsTool,
      handler: withValidation(client, async (c, params) => {
        const result = await c.listProjects(
          params as { search?: string; limit?: number; owned?: boolean }
        );
        return jsonResult({
          projects: result.map((p: { id: number; path_with_namespace: string }) => ({
            id: p.id,
            path: p.path_with_namespace,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getProjectFullTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, include = [] } = params as {
          project_id: string | number;
          include?: string[];
        };
        const result = await c.showProject(project_id, {
          license: include.includes('license'),
          statistics: include.includes('statistics'),
        });
        return jsonResult(result);
      }),
    },
    {
      tool: searchCodeTool,
      handler: withValidation(client, async (c, params) => {
        const { query, ...options } = params as { query: string; project_id?: string | number };
        const result = await c.searchCode(query, options);
        return jsonResult(result);
      }),
    },
  ];
}
