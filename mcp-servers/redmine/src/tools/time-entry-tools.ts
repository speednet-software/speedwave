/**
 * Time Entry Tools - 3 tools for Redmine time tracking
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';
import { resolveParams } from './helpers.js';

const listTimeEntriesTool: Tool = {
  name: 'listTimeEntries',
  description: 'List time entries with optional filters.',
  category: 'read',
  keywords: ['redmine', 'time', 'entries', 'list', 'hours', 'log'],
  example: `const entries = await redmine.listTimeEntries({ issue_id: 12345 })`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            hours: { type: 'number' },
            activity: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            comments: { type: 'string' },
            spent_on: { type: 'string', description: 'Date in YYYY-MM-DD format' },
            user: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            issue: { type: 'object', properties: { id: { type: 'number' } } },
          },
        },
      },
      total_count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: list all entries',
      input: {},
    },
    {
      description: 'Partial: entries for issue',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: date range with limit',
      input: { from: '2024-01-01', to: '2024-01-31', user_id: 42, limit: 100 },
    },
  ],
};

const createTimeEntryTool: Tool = {
  name: 'createTimeEntry',
  description: 'Log time on an issue or project',
  category: 'write',
  keywords: ['redmine', 'time', 'entry', 'create', 'log', 'hours'],
  example: `await redmine.createTimeEntry({ hours: 2.5, issue_id: 12345, activity: "development", comments: "Code review" })`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entry: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID of created time entry' },
          hours: { type: 'number' },
          activity: {
            type: 'object',
            properties: { id: { type: 'number' }, name: { type: 'string' } },
          },
          spent_on: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: log hours to issue',
      input: { hours: 2.5, issue_id: 12345 },
    },
    {
      description: 'Partial: with activity and comment',
      input: {
        hours: 4.0,
        issue_id: 12345,
        activity: 'development',
        comments: 'Implemented feature X',
      },
    },
    {
      description: 'Full: log to specific date',
      input: {
        hours: 8.0,
        issue_id: 12345,
        activity: 'development',
        comments: 'Full day refactoring',
        spent_on: '2024-01-15',
      },
    },
  ],
};

const updateTimeEntryTool: Tool = {
  name: 'updateTimeEntry',
  description: 'Update an existing time entry',
  category: 'write',
  keywords: ['redmine', 'time', 'update', 'modify', 'hours', 'edit'],
  example: `await redmine.updateTimeEntry({ time_entry_id: 789, hours: 3.5 })`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      time_entry: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          hours: { type: 'number' },
          activity: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: update hours only',
      input: { time_entry_id: 789, hours: 3.5 },
    },
    {
      description: 'Partial: update activity and comments',
      input: { time_entry_id: 789, activity: 'testing', comments: 'Updated test description' },
    },
    {
      description: 'Full: update all fields',
      input: {
        time_entry_id: 789,
        hours: 4.0,
        activity: 'development',
        comments: 'Corrected hours and activity',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createTimeEntryTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
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
