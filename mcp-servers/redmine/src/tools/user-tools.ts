/**
 * User Tools - 3 tools for Redmine user operations
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const listUsersTool: Tool = {
  name: 'listUsers',
  description:
    'List users (optionally filtered by project membership). If this worker is scoped to a single project, project_id is forced to that project and a different value throws an error.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['redmine', 'users', 'list', 'members', 'team', 'assignable'],
  example: `const users = await redmine.listUsers({ project_id: "my-project" })`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Filter by project membership' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      users: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            login: { type: 'string' },
            firstname: { type: 'string' },
            lastname: { type: 'string' },
            mail: { type: 'string' },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: list all users',
      input: {},
    },
    {
      description: 'Partial: list project members',
      input: { project_id: 'my-project' },
    },
    {
      description: 'Full: list specific project team',
      input: { project_id: 'speedwave-core' },
    },
  ],
};

const resolveUserTool: Tool = {
  name: 'resolveUser',
  description: "Resolve user identifier to user ID (supports 'me', user ID, or username)",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.SELF_PARAM]: "identifier: 'me'",
  },
  keywords: ['redmine', 'user', 'resolve', 'lookup', 'identity', 'id'],
  example: `const { user_id } = await redmine.resolveUser({ identifier: "john@example.com" })`,
  inputSchema: {
    type: 'object',
    properties: {
      identifier: { type: 'string', description: "User identifier ('me', user ID, or username)" },
    },
    required: ['identifier'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user_id: {
        type: ['number', 'null'],
        description: 'Resolved user ID, or null if not found',
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: resolve current user',
      input: { identifier: 'me' },
    },
    {
      description: 'Partial: resolve by email',
      input: { identifier: 'john@example.com' },
    },
    {
      description: 'Full: resolve by name',
      input: { identifier: 'jane.doe' },
    },
  ],
};

const getCurrentUserTool: Tool = {
  name: 'getCurrentUser',
  description: "Get current authenticated user's profile (id, login, email, name)",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: true,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['redmine', 'user', 'profile', 'current', 'me', 'authenticated'],
  example: `const user = await redmine.getCurrentUser()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          login: { type: 'string' },
          firstname: { type: 'string' },
          lastname: { type: 'string' },
          mail: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createUserTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
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
        const { project_id } = params as { project_id?: string };
        try {
          const result = await client.listUsers(project_id);
          return jsonResult(result);
        } catch (error) {
          return errorResult(
            RedmineClient.formatError(error, project_id ? `project_id=${project_id}` : undefined)
          );
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
