/**
 * Journal Tools - 3 tools for Redmine journal/comments
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { RedmineClient } from '../client.js';

const listJournalsTool: Tool = {
  name: 'listJournals',
  description: 'List all journals (comments/updates) for an issue',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['redmine', 'journals', 'history', 'comments', 'audit', 'changelog'],
  example: `const journals = await redmine.listJournals({ issue_id: 12345 })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
    },
    required: ['issue_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            user: {
              type: 'object',
              properties: { id: { type: 'number' }, name: { type: 'string' } },
            },
            notes: { type: 'string' },
            created_on: { type: 'string' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  property: { type: 'string' },
                  name: { type: 'string' },
                  old_value: { type: 'string' },
                  new_value: { type: 'string' },
                },
              },
            },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get all journals for issue',
      input: { issue_id: 12345 },
    },
    {
      description: 'Full: get journal history',
      input: { issue_id: 67890 },
    },
  ],
};

const updateJournalTool: Tool = {
  name: 'updateJournal',
  description: 'Update an existing journal entry',
  annotations: WRITE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['redmine', 'journal', 'update', 'comment', 'edit', 'modify'],
  example: `await redmine.updateJournal({ issue_id: 12345, journal_id: 67890, notes: "Updated comment with more details" })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal ID' },
      notes: { type: 'string', description: 'Updated notes' },
    },
    required: ['issue_id', 'journal_id', 'notes'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      journal: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          notes: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: update journal note',
      input: { issue_id: 12345, journal_id: 67890, notes: 'Updated comment with more details' },
    },
    {
      description: 'Full: update with detailed note',
      input: {
        issue_id: 12345,
        journal_id: 67890,
        notes: 'h3. Correction\n\nPrevious analysis was incorrect. Updated with new findings.',
      },
    },
  ],
};

const deleteJournalTool: Tool = {
  name: 'deleteJournal',
  description: 'Delete a journal entry',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { deferLoading: true },
  keywords: ['redmine', 'journal', 'delete', 'remove', 'comment'],
  example: `await redmine.deleteJournal({ issue_id: 12345, journal_id: 67890 })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal ID to delete' },
    },
    required: ['issue_id', 'journal_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      deleted_journal_id: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: delete a journal entry',
      input: { issue_id: 12345, journal_id: 67890 },
    },
    {
      description: 'Full: remove comment from history',
      input: { issue_id: 67890, journal_id: 54321 },
    },
  ],
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createJournalTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
  if (!client) {
    return [
      { tool: listJournalsTool, handler: unconfigured },
      { tool: updateJournalTool, handler: unconfigured },
      { tool: deleteJournalTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listJournalsTool,
      handler: async (params) => {
        try {
          const { issue_id } = params as { issue_id: number };
          const result = await client.listJournals(issue_id);
          return jsonResult(result);
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: updateJournalTool,
      handler: async (params) => {
        try {
          const { issue_id, journal_id, notes } = params as {
            issue_id: number;
            journal_id: number;
            notes: string;
          };
          await client.updateJournal(issue_id, journal_id, notes);
          return jsonResult({ ok: true });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
    {
      tool: deleteJournalTool,
      handler: async (params) => {
        try {
          const { issue_id, journal_id } = params as { issue_id: number; journal_id: number };
          await client.deleteJournal(issue_id, journal_id);
          return jsonResult({ ok: true });
        } catch (error) {
          return errorResult(RedmineClient.formatError(error));
        }
      },
    },
  ];
}
