/**
 * Time Entry Tools - 3 tools for Redmine time tracking
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { resolveParams } from './helpers.js';

const listTimeEntriesTool: Tool = {
  name: 'listTimeEntries',
  description: 'List time entries with optional filters.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Filter by issue ID' },
      project_id: { type: 'string', description: 'Filter by project ID' },
      user_id: { type: 'number', description: 'Filter by user ID' },
      from: { type: 'string', description: 'From date (YYYY-MM-DD)' },
      to: { type: 'string', description: 'To date (YYYY-MM-DD)' },
      limit: { type: 'number', description: 'Maximum results (default 25)' },
    },
  },
};

const createTimeEntryTool: Tool = {
  name: 'createTimeEntry',
  description: 'Log time on an issue or project',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID (required if project_id not provided)' },
      project_id: { type: 'string', description: 'Project ID (required if issue_id not provided)' },
      hours: { type: 'number', description: 'Hours spent' },
      activity_id: { type: 'number', description: 'Activity ID' },
      activity: { type: 'string', description: 'Activity name' },
      comments: { type: 'string', description: 'Time entry comments' },
      spent_on: { type: 'string', description: 'Date spent (YYYY-MM-DD, default today)' },
    },
    required: ['hours'],
  },
};

const updateTimeEntryTool: Tool = {
  name: 'updateTimeEntry',
  description: 'Update an existing time entry',
  inputSchema: {
    type: 'object',
    properties: {
      time_entry_id: { type: 'number', description: 'Time entry ID' },
      hours: { type: 'number', description: 'Updated hours' },
      activity_id: { type: 'number', description: 'Updated activity ID' },
      activity: { type: 'string', description: 'Activity name' },
      comments: { type: 'string', description: 'Updated comments' },
    },
    required: ['time_entry_id'],
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createTimeEntryTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
  if (!client) {
    return [
      { tool: listTimeEntriesTool, handler: unconfigured },
      { tool: createTimeEntryTool, handler: unconfigured },
      { tool: updateTimeEntryTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listTimeEntriesTool,
      handler: async (params) => {
        try {
          const result = await client.listTimeEntries(
            params as Parameters<typeof client.listTimeEntries>[0]
          );
          return jsonResult({ time_entries: result.time_entries, total_count: result.total_count });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: createTimeEntryTool,
      handler: async (params) => {
        try {
          const resolved = resolveParams(params as Record<string, unknown>, client.getMappings());
          const result = await client.createTimeEntry(
            resolved as Parameters<typeof client.createTimeEntry>[0]
          );
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: updateTimeEntryTool,
      handler: async (params) => {
        try {
          const resolved = resolveParams(params as Record<string, unknown>, client.getMappings());
          const { time_entry_id } = resolved as { time_entry_id: number };
          await client.updateTimeEntry(
            time_entry_id,
            resolved as Parameters<typeof client.updateTimeEntry>[1]
          );
          return jsonResult({ ok: true });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
