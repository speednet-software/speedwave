/**
 * Slack: Get Users
 *
 * Get user information by email address.
 * Useful for resolving user identities in workflows.
 * @param {string} email - Email address of the user to lookup
 * @returns {object} User information (id, username, real_name, email)
 * @example
 * // Lookup user by email
 * const user = await slack.getUsers({
 *   email: "alice@example.com"
 * });
 * console.log(`Found: ${user.real_name} (@${user.name})`);
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getUsers',
  service: 'slack',
  category: 'read',
  deferLoading: true,
  description: 'Get user information by email address',
  keywords: ['slack', 'user', 'email', 'lookup', 'find'],
  inputSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Email address of the user' },
    },
    required: ['email'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      user: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'User ID' },
          name: { type: 'string', description: 'Display name' },
          email: { type: 'string' },
          real_name: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const user = await slack.getUsers({ email: "alice@example.com" })`,
  inputExamples: [
    {
      description: 'Lookup user by email',
      input: { email: 'john@example.com' },
    },
  ],
};

/**
 * Slack user information
 */
interface UserInfo {
  /** Slack user ID */
  id: string;
  /** Username (without @ prefix) */
  name: string;
  /** Full display name */
  real_name: string;
  /** Email address */
  email: string;
}

/**
 * Execute get_users tool
 * Looks up user information by email address
 * @param params - User lookup parameters
 * @param params.email - Email address of the user to lookup
 * @param context - Execution context with slack service
 * @param context.slack - Slack service bridge instance
 * @param context.slack.getUsers - Function to get user list
 * @returns User information (id, username, real_name, email) or error
 */
export async function execute(
  params: { email: string },
  context: { slack: { getUsers: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; user?: UserInfo; error?: string }> {
  const { email } = params;

  if (!email) {
    return {
      success: false,
      error: 'Missing required field: email',
    };
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return {
      success: false,
      error: 'Invalid email format',
    };
  }

  try {
    const result = await context.slack.getUsers({ email });

    // Parse result - MCP returns user info
    const resultData = result as { user?: UserInfo };

    return {
      success: true,
      user: resultData.user,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
