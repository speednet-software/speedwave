/**
 * User Tools - Tools for Slack user operations
 */

import { Tool, ToolDefinition } from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import { SlackClients, getUsers, formatSlackError } from '../client.js';

interface GetUsersParams {
  email: string;
}

const getUsersTool: Tool = {
  name: 'getUsers',
  description: 'Look up a Slack user by email address',
  inputSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Email address to look up' },
    },
    required: ['email'],
  },
};

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleGetUsers(
  clients: SlackClients,
  params: GetUsersParams
): Promise<ToolResult> {
  try {
    const result = await getUsers(clients, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'LOOKUP_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool handler function
 * @param clients - Slack client instances
 */
export function createUserTools(clients: SlackClients | null): ToolDefinition[] {
  const withClients =
    <T>(handler: (c: SlackClients, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (!clients) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: 'Slack not configured. Run: speedwave setup slack',
          },
        };
      }
      return handler(clients, params);
    };

  return [
    { tool: getUsersTool, handler: withValidation<GetUsersParams>(withClients(handleGetUsers)) },
  ];
}
