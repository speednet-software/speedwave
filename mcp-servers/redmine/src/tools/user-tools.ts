/**
 * User Tools - 3 tools for Redmine user operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const listUsersTool: Tool = {
  name: 'listUsers',
  description: 'List users (optionally filtered by project membership)',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter by project membership' },
    },
  },
};

const resolveUserTool: Tool = {
  name: 'resolveUser',
  description: "Resolve user identifier to user ID (supports 'me', user ID, or username)",
  inputSchema: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: "User identifier ('me', user ID, or username)" },
    },
    required: ['identifier'],
  },
};

const getCurrentUserTool: Tool = {
  name: 'getCurrentUser',
  description: "Get current authenticated user's profile (id, login, email, name)",
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createUserTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
  if (!client) {
    return [
      { tool: listUsersTool, handler: unconfigured },
      { tool: resolveUserTool, handler: unconfigured },
      { tool: getCurrentUserTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listUsersTool,
      handler: async (params) => {
        try {
          const { project_id } = params as { project_id?: string };
          const result = await client.listUsers(project_id);
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: resolveUserTool,
      handler: async (params) => {
        try {
          const { identifier } = params as { identifier: string };
          const result = await client.resolveUser(identifier);
          return jsonResult({ user_id: result });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: getCurrentUserTool,
      handler: async () => {
        try {
          const result = await client.getCurrentUser();
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
