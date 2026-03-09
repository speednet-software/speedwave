/**
 * Redmine: Get Project Full
 *
 * Returns complete project data including trackers, categories, and modules.
 * @param {string|number} project_id - Project ID or identifier
 * @param {string[]} [include] - Additional data to include
 * @returns {object} Full project data
 * @example
 * const project = await redmine.getProjectFull({ project_id: 'my-project' });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getProjectFull',
  service: 'redmine',
  category: 'read',
  description: 'Get complete project data including trackers, categories, modules. No truncation.',
  keywords: ['redmine', 'project', 'details', 'full', 'trackers', 'categories', 'modules'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID (numeric) or identifier (string slug)',
      },
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'trackers',
            'issue_categories',
            'enabled_modules',
            'time_entry_activities',
            'issue_custom_fields',
          ],
        },
        description: 'Additional data to include',
      },
    },
    required: ['project_id'],
  },
  example: `const project = await redmine.getProjectFull({ project_id: 'my-project' })`,
  deferLoading: true,
};
