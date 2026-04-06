/**
 * User Tools - Tools for SharePoint user operations
 */

import { Tool, ToolDefinition, notConfiguredMessage } from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';

const getCurrentUserTool: Tool = {
  name: 'getCurrentUser',
  description: 'Get information about the currently authenticated SharePoint user',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['sharepoint', 'user', 'current', 'me', 'auth'],
  example: 'const user = await sharepoint.getCurrentUser()',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string' },
          email: { type: 'string' },
          userPrincipalName: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get current user (no params)',
      input: {},
    },
  ],
};

/**
 * Get current SharePoint user info
 * @param client - SharePoint client instance
 */
export async function handleGetCurrentUser(client: SharePointClient): Promise<ToolResult> {
  try {
    const result = await client.getCurrentUser();
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: { code: 'USER_FAILED', message: SharePointClient.formatError(error) },
    };
  }
}

/**
 * Create user-related tool definitions
 * @param client - SharePoint client instance
 */
export function createUserTools(client: SharePointClient | null): ToolDefinition[] {
  const withClient =
    (handler: (c: SharePointClient) => Promise<ToolResult>) => async (): Promise<ToolResult> => {
      if (!client) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('SharePoint'),
          },
        };
      }
      return handler(client);
    };

  return [
    {
      tool: getCurrentUserTool,
      handler: withValidation<Record<string, unknown>>(withClient(handleGetCurrentUser)),
    },
  ];
}
