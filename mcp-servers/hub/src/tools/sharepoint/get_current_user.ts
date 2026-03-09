/**
 * SharePoint: Get Current User
 *
 * Get current authenticated user information from SharePoint.
 * Returns user identity details for the configured OAuth session.
 * @returns {object} User information (name, email, username)
 * @example
 * // Get current user identity
 * const user = await sharepoint.getCurrentUser();
 * console.log(`Logged in as: ${user.email}`);
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getCurrentUser',
  service: 'sharepoint',
  category: 'read',
  deferLoading: true,
  description: 'Get current authenticated user information from SharePoint',
  keywords: ['sharepoint', 'user', 'current', 'me', 'auth'],
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
  example: `const user = await sharepoint.getCurrentUser()`,
  inputExamples: [
    {
      description: 'Get current user (no params)',
      input: {},
    },
  ],
};

/**
 * SharePoint user information
 */
interface UserInfo {
  /** Display name of the user */
  name: string;
  /** Email address of the user */
  email: string;
  /** Username/login identifier */
  username: string;
}

/**
 * Execute get_current_user tool
 * Retrieves current authenticated user information from SharePoint
 * @param params - No parameters required
 * @param context - Execution context with sharepoint service
 * @param context.sharepoint - SharePoint service bridge instance
 * @param context.sharepoint.getCurrentUser - Function to get current user info
 * @returns User information (name, email, username) or error
 */
export async function execute(
  params: Record<string, unknown>,
  context: { sharepoint: { getCurrentUser: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; user?: UserInfo; error?: string }> {
  try {
    const result = await context.sharepoint.getCurrentUser({});

    return {
      success: true,
      user: result as UserInfo,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
