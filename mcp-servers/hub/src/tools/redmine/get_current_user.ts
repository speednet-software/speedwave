/**
 * Redmine: Get Current User
 *
 * Returns the authenticated user's profile information.
 * @returns {object} User profile with id, login, email, name
 * @example
 * const user = await redmine.getCurrentUser();
 * console.log(user.login, user.email);
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getCurrentUser',
  service: 'redmine',
  category: 'read',
  description: "Get current authenticated user's profile (id, login, email, name)",
  keywords: ['redmine', 'user', 'profile', 'current', 'me', 'authenticated'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  example: `const user = await redmine.getCurrentUser()`,
  deferLoading: true,
};
