/**
 * Config Tools - 2 tools for Redmine configuration
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const getMappingsTool: Tool = {
  name: 'getMappings',
  description: 'Get project-specific Redmine ID mappings (status, priority, tracker, activity)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const getConfigTool: Tool = {
  name: 'getConfig',
  description: 'Get project configuration (default project_id, project_name, Redmine URL)',
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
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
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
