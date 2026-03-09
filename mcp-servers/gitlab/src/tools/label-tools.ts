/**
 * Label Tools - 2 tools for GitLab project labels
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listLabelsTool: Tool = {
  name: 'listLabels',
  description: 'List project labels',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      search: { type: 'string', description: 'Search by name' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
    required: ['project_id'],
  },
};

const createLabelTool: Tool = {
  name: 'createLabel',
  description: 'Create a project label',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      name: { type: 'string', description: 'Label name' },
      color: { type: 'string', description: 'Color hex code (e.g., #FF0000)' },
      description: { type: 'string', description: 'Label description' },
    },
    required: ['project_id', 'name', 'color'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createLabelTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listLabelsTool, handler: unconfigured },
      { tool: createLabelTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listLabelsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          search?: string;
          limit?: number;
        };
        const result = await c.listLabels(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: createLabelTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          name: string;
          color: string;
          description?: string;
        };
        const result = await c.createLabel(project_id, options);
        return jsonResult(result);
      }),
    },
  ];
}
