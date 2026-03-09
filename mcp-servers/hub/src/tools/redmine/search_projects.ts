/**
 * Redmine: Search Project IDs
 *
 * Searches projects by name, identifier, or description.
 * Returns matching IDs and basic info.
 * @param {string} query - Search query
 * @param {number} [limit] - Maximum results (default: 25)
 * @returns {object} Matching project IDs
 * @example
 * const { ids } = await redmine.searchProjectIds({ query: 'mobile' });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'searchProjectIds',
  service: 'redmine',
  category: 'read',
  description: 'Search projects by name, identifier or description. Returns matching IDs only.',
  keywords: ['redmine', 'projects', 'search', 'find', 'query', 'name'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (searches name, identifier, description)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 25)',
      },
    },
    required: ['query'],
  },
  example: `const { ids } = await redmine.searchProjectIds({ query: 'mobile' })`,
  deferLoading: true,
};
