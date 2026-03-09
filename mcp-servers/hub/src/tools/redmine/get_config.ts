/**
 * Redmine: Get Config
 *
 * Returns project configuration including default project_id, project_name, and Redmine URL.
 * @returns {object} Configuration with project_id, project_name, url
 * @example
 * const config = await redmine.getConfig();
 * console.log(config.project_id, config.url);
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'getConfig',
  service: 'redmine',
  category: 'read',
  description: 'Get project configuration (default project_id, project_name, Redmine URL)',
  keywords: ['redmine', 'config', 'configuration', 'project', 'url', 'settings'],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  example: `const config = await redmine.getConfig()`,
  deferLoading: true,
};
