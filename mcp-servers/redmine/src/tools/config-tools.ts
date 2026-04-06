/**
 * Config Tools - 2 tools for Redmine configuration
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const getMappingsTool: Tool = {
  name: 'getMappings',
  description: 'Get project-specific Redmine ID mappings (status, priority, tracker, activity)',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['redmine', 'mappings', 'config', 'status', 'priority', 'tracker', 'activity'],
  example: `const mappings = await redmine.getMappings()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      statuses: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      priorities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      trackers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      activities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, name: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get all Redmine mappings (no params)',
      input: {},
    },
  ],
};

const getConfigTool: Tool = {
  name: 'getConfig',
  description:
    'Get project configuration (default project_id, project_name, Redmine URL). project_name is auto-fetched from the Redmine API at startup when absent from config.',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['redmine', 'config', 'configuration', 'project', 'url', 'settings'],
  example: `const config = await redmine.getConfig()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createConfigTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: getMappingsTool, handler: unconfigured },
      { tool: getConfigTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: getMappingsTool,
      handler: async () => {
        try {
          const result = client.getMappings();
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: getConfigTool,
      handler: async () => {
        try {
          const result = client.getConfig();
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
