/**
 * Redmine: List Project IDs
 *
 * Lists project IDs with optional filters.
 * Returns only IDs for efficiency. Use getProjectFull for complete details.
 * @param {string} [status] - Filter by status (active, closed, archived, all)
 * @param {number} [limit] - Maximum results (default: 25, max: 100)
 * @param {number} [offset] - Skip N projects for pagination
 * @returns {object} List of project IDs
 * @example
 * const { ids } = await redmine.listProjectIds({ status: 'active' });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'listProjectIds',
  service: 'redmine',
  category: 'read',
  description:
    'List project IDs with optional filters. Returns only IDs for efficiency. Use getProjectFull for details.',
  keywords: ['redmine', 'projects', 'list', 'ids', 'filter', 'active', 'closed'],
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'closed', 'archived', 'all'],
        description: 'Project status filter (default: all)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of projects to return (default: 25, max: 100)',
      },
      offset: {
        type: 'number',
        description: 'Number of projects to skip (for pagination)',
      },
    },
  },
  example: `const { ids } = await redmine.listProjectIds({ status: 'active' })`,
  deferLoading: true,
};
