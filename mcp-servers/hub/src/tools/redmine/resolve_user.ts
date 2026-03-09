/**
 * Redmine: Resolve User
 *
 * Resolve user identifier (me, name, email) to numeric user ID.
 * @param {string} identifier - User identifier: 'me', user ID, name, or email
 * @returns {object} Resolved user ID
 * @example
 * // Resolve current user
 * const me = await redmine.resolveUser({ identifier: "me" });
 *
 * // Resolve by email
 * const user = await redmine.resolveUser({
 *   identifier: "alice@example.com"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'resolveUser',
  category: 'read',
  service: 'redmine',
  description: 'Resolve user identifier (me, name, email) to numeric user ID',
  keywords: ['redmine', 'user', 'resolve', 'lookup', 'identity', 'id'],
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: "User identifier: 'me', user ID, name, or email",
      },
    },
    required: ['identifier'],
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
  example: `const user = await redmine.resolveUser({ identifier: "john@example.com" })`,
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
  deferLoading: true,
};

/**
 * Resolved user information from Redmine.
 * @interface ResolvedUser
 */
interface ResolvedUser {
  /** Numeric user ID */
  id: number;
  /** User login/username */
  login: string;
  /** User full name */
  name: string;
}

/**
 * Execute the resolve_user tool.
 * @param params - Tool parameters including user identifier
 * @param params.identifier - User identifier (name or email)
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.resolveUser - Function to resolve user by name/email
 * @returns Promise resolving to resolved user information or error
 */
export async function execute(
  params: { identifier: string },
  context: { redmine: { resolveUser: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; user?: ResolvedUser; error?: string }> {
  const { identifier } = params;

  if (!identifier) {
    return {
      success: false,
      error: 'Missing required field: identifier',
    };
  }

  try {
    const result = await context.redmine.resolveUser(params);

    return {
      success: true,
      user: result as ResolvedUser,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
