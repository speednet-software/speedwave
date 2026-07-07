/**
 * Config Tools - 2 tools for Redmine configuration
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const getMappingsTool: Tool = {
  name: 'getMappings',
  description:
    'Get project-specific Redmine ID mappings (status, priority, tracker, activity). Returns a flat object keyed by mapping name (e.g. status_new, priority_high, tracker_bug, activity_development) mapped to the configured numeric ID — not an array of {id, name} objects, and no success wrapper.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { 'speedwave.pl/defer-loading': true },
  keywords: ['redmine', 'mappings', 'config', 'status', 'priority', 'tracker', 'activity'],
  example: `const mappings = await redmine.getMappings()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    description:
      'Flat map of configured mapping keys to numeric Redmine IDs. Only keys with a configured mapping are present; an unconfigured project may return {}.',
    properties: {
      status_new: { type: 'number' },
      status_in_progress: { type: 'number' },
      status_resolved: { type: 'number' },
      status_feedback: { type: 'number' },
      status_closed: { type: 'number' },
      status_rejected: { type: 'number' },
      priority_low: { type: 'number' },
      priority_normal: { type: 'number' },
      priority_high: { type: 'number' },
      priority_urgent: { type: 'number' },
      priority_immediate: { type: 'number' },
      tracker_bug: { type: 'number' },
      tracker_feature: { type: 'number' },
      tracker_task: { type: 'number' },
      tracker_support: { type: 'number' },
      activity_design: { type: 'number' },
      activity_development: { type: 'number' },
      activity_testing: { type: 'number' },
    },
  },
  inputExamples: [
    {
      description: 'Get all Redmine mappings (no params)',
      input: {},
    },
  ],
};

const getConfigTool: Tool = {
  name: 'getConfig',
  description:
    'Get project configuration (default project_id, project_name, Redmine URL). project_name is auto-fetched from the Redmine API at startup when absent from config.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { 'speedwave.pl/defer-loading': true },
  keywords: ['redmine', 'config', 'configuration', 'project', 'url', 'settings'],
  example: `const config = await redmine.getConfig()`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Configured default project ID, if any' },
      project_name: { type: 'string', description: 'Configured or auto-fetched project name' },
      url: { type: 'string', description: 'Redmine instance base URL' },
    },
  },
  inputExamples: [
    {
      description: 'Get current project configuration',
      input: {},
    },
  ],
};

/**
 * Builds the Redmine config tool definitions.
 * @param client - Redmine client instance
 */
export function createConfigTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: getMappingsTool, handler: unconfigured },
      { tool: getConfigTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: getMappingsTool,
      handler: async () => {
        try {
          const result = client.getMappings();
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: getConfigTool,
      handler: async () => {
        try {
          const result = await client.getConfig();
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
