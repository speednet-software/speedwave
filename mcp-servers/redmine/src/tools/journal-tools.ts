/**
 * Journal Tools - 3 tools for Redmine journal/comments
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { RedmineClient } from '../client.js';

const listJournalsTool: Tool = {
  name: 'listJournals',
  description: 'List all journals (comments/updates) for an issue',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
    },
    required: ['issue_id'],
  },
};

const updateJournalTool: Tool = {
  name: 'updateJournal',
  description: 'Update an existing journal entry',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal ID' },
      notes: { type: 'string', description: 'Updated notes' },
    },
    required: ['issue_id', 'journal_id', 'notes'],
  },
};

const deleteJournalTool: Tool = {
  name: 'deleteJournal',
  description: 'Delete a journal entry',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID' },
      journal_id: { type: 'number', description: 'Journal ID to delete' },
    },
    required: ['issue_id', 'journal_id'],
  },
};

/**
 * Tool handler function
 * @param client - Redmine client instance
 */
export function createJournalTools(client: RedmineClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('Redmine not configured. Run: speedwave setup redmine');
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
