/**
 * Redmine: List Users
 *
 * List all assignable users (optionally filtered by project).
 * @param {string} [project_id] - Project ID (returns project members only)
 * @returns {object} Array of users
 * @example
 * // List all users
 * const users = await redmine.listUsers();
 *
 * // List project members
 * const members = await redmine.listUsers({
 *   project_id: "speedwave-core"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listUsers',
  category: 'read',
  service: 'redmine',
  description: 'List all assignable users (optionally filtered by project)',
  keywords: ['redmine', 'users', 'list', 'members', 'team', 'assignable'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project ID (returns project members only)' },
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
  example: `const users = await redmine.listUsers({ project_id: "my-project" })`,
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
  deferLoading: true,
};

/**
 * User information from Redmine.
 * @interface User
 */
interface User {
  /** Numeric user ID */
  id: number;
  /** User login/username */
  login: string;
  /** User first name */
  firstname: string;
  /** User last name */
  lastname: string;
  /** User email address (optional) */
  mail?: string;
}

/**
 * Execute the list_users tool.
 * @param params - Tool parameters including optional project_id filter
 * @param params.project_id - Project ID or path
 * @param context - Execution context with Redmine client
 * @param context.redmine - Redmine service bridge instance
 * @param context.redmine.listUsers - Function to list users
 * @returns Promise resolving to array of users or error
 */
export async function execute(
  params: { project_id?: string },
  context: { redmine: { listUsers: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; users?: User[]; error?: string }> {
  try {
    const result = await context.redmine.listUsers(params);
    const data = result as { users?: User[] };

    return {
      success: true,
      users: data.users || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
