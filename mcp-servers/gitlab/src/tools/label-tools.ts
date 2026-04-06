/**
 * Label Tools - 2 tools for GitLab project labels
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listLabelsTool: Tool = {
  name: 'listLabels',
  description: 'List project labels',
  keywords: ['gitlab', 'labels', 'list', 'tags'],
  example: 'const labels = await gitlab.listLabels({ project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      search: { type: 'string', description: 'Search by name' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            color: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List project labels',
      input: { project_id: 'my-group/my-project' },
    },
  ],
};

const createLabelTool: Tool = {
  name: 'createLabel',
  description: 'Create a project label',
  keywords: ['gitlab', 'label', 'create', 'new', 'tag'],
  example:
    'const label = await gitlab.createLabel({ project_id: "speedwave/core", name: "urgent", color: "#FF0000" })',
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      label: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          color: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Create label',
      input: {
        project_id: 'my-group/my-project',
        name: 'bug',
        color: '#FF0000',
      },
    },
    {
      description: 'Create label with description',
      input: {
        project_id: 'my-group/my-project',
        name: 'feature',
        color: '#00FF00',
        description: 'New feature request',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createLabelTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
