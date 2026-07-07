/**
 * User Tools - Tools for Slack user operations
 */

import { Tool, ToolDefinition, READ_ONLY_ANNOTATIONS, META_KEYS } from '@speedwave/mcp-shared';
import { withValidation, withClients, ToolResult } from './validation.js';
import { SlackClients, getUsers, getCurrentUser, formatSlackError } from '../client.js';
import { searchUsers } from '../user-directory.js';

interface GetUsersParams {
  email: string;
}

interface FindUsersParams {
  query: string;
  limit?: number;
}

const getUsersTool: Tool = {
  name: 'getUsers',
  description:
    "Look up a Slack user by exact email address. For finding people by name, use findUsers. To resolve the SIGNED-IN user's own identity, use getCurrentUser instead.",
  inputSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Email address to look up' },
    },
    required: ['email'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['slack', 'user', 'email', 'lookup', 'find'],
  example: 'const user = await slack.getUsers({ email: "alice@example.com" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'User ID' },
          name: { type: 'string', description: 'Username handle' },
          email: { type: 'string' },
          real_name: { type: 'string' },
          display_name: { type: 'string', description: 'Profile display name' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Lookup user by email',
      input: { email: 'john@example.com' },
    },
  ],
};

const findUsersTool: Tool = {
  name: 'findUsers',
  description:
    'Search workspace users by display or real name (partial, case- and diacritic-insensitive). Returns id, names, email. Names are not unique — when several match, ask the user which person they mean before any DM. For exact email lookup use getUsers.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Partial name to match (e.g. "pawel")' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
    required: ['query'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['slack', 'user', 'find', 'search', 'name', 'person', 'who', 'dm'],
  example: 'const hits = await slack.findUsers({ query: "pawel" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      users: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'User ID (U…) — pass to openDirectMessage' },
            name: { type: 'string', description: 'Username handle' },
            real_name: { type: 'string' },
            display_name: { type: 'string' },
            email: { type: 'string' },
            is_bot: { type: 'boolean' },
          },
          required: ['id', 'name'],
        },
      },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Find a person by first name before opening a DM',
      input: { query: 'pawel' },
    },
  ],
};

const getCurrentUserTool: Tool = {
  name: 'getCurrentUser',
  description:
    'Resolve the SIGNED-IN user\'s own Slack identity (id, name, real name, team). This is the only ground truth for "me" — to find messages the signed-in user sent or was addressed to, call this first and compare the returned `id` against the `user` field in getChannelMessages/getThreadMessages results.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['slack', 'user', 'me', 'myself', 'current', 'whoami', 'identity', 'self'],
  example: 'const me = await slack.getCurrentUser()',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      id: { type: 'string', description: "The signed-in user's own Slack user ID" },
      name: { type: 'string', description: 'Username handle' },
      real_name: { type: 'string' },
      display_name: { type: 'string', description: 'Profile display name' },
      team_id: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Resolve the signed-in user before filtering "my messages"',
      input: {},
    },
  ],
};

/**
 * Tool handler function
 * @param clients - Slack client instances
 * @param params - Tool parameters
 */
export async function handleFindUsers(
  clients: SlackClients,
  params: FindUsersParams
): Promise<ToolResult> {
  try {
    const users = await searchUsers(clients, params);
    return { success: true, data: { users, count: users.length } };
  } catch (error) {
    return { success: false, error: { code: 'SEARCH_FAILED', message: formatSlackError(error) } };
  }
}

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
 * @param _params - Tool parameters (none)
 */
export async function handleGetCurrentUser(
  clients: SlackClients,
  _params: Record<string, never>
): Promise<ToolResult> {
  try {
    const user = await getCurrentUser(clients);
    return { success: true, data: user };
  } catch (error) {
    return { success: false, error: { code: 'LOOKUP_FAILED', message: formatSlackError(error) } };
  }
}

/**
 * Tool handler function.
 * @param clients - Slack client instances (always non-null; checks
 *   `_tokensStatus === 'missing'` to surface the configuration error).
 */
export function createUserTools(clients: SlackClients): ToolDefinition[] {
  const gate = withClients(clients);

  return [
    { tool: getUsersTool, handler: withValidation<GetUsersParams>(gate(handleGetUsers)) },
    { tool: findUsersTool, handler: withValidation<FindUsersParams>(gate(handleFindUsers)) },
    {
      tool: getCurrentUserTool,
      handler: withValidation<Record<string, never>>(gate(handleGetCurrentUser)),
    },
  ];
}
